import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv';
import type { ForgeState } from '../shared/types.js';

export interface RuntimeSourceEntry {
  upstreamPath: string;
  localPath: string;
  blobSha: string;
  role: 'model-schema' | 'valid-vector' | 'invalid-vector';
}

export interface RuntimeLock {
  version: number;
  repository: string;
  commit: string;
  schemaVersion: string;
  sources: RuntimeSourceEntry[];
}

export interface RuntimeVerification {
  repository: string;
  commit: string;
  verified: Array<{ upstreamPath: string; localPath: string; role: string; blobSha: string; bytes: number }>;
}

const lockPath = resolve(process.env.FORGER_RUNTIME_LOCK ?? 'runtime.lock.json');
let validatorPromise: Promise<ValidateFunction> | undefined;

function gitBlobSha(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

function rawUrl(lock: RuntimeLock, path: string): string {
  return `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

export async function loadRuntimeLock(): Promise<RuntimeLock> {
  const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as RuntimeLock;
  if (parsed.version !== 1) throw new Error(`Unsupported runtime lock version: ${parsed.version}`);
  if (!/^[0-9a-f]{40}$/.test(parsed.commit)) throw new Error('Runtime lock must pin a full 40-character commit SHA');
  if (!parsed.repository.includes('/')) throw new Error('Runtime lock repository must be owner/name');
  if (parsed.schemaVersion !== '1.0') throw new Error(`Unsupported AllasCode model schema version: ${parsed.schemaVersion}`);
  if (!Array.isArray(parsed.sources) || parsed.sources.length < 3) throw new Error('Runtime lock must pin schema and canonical test vectors');
  for (const source of parsed.sources) {
    if (!/^[0-9a-f]{40}$/.test(source.blobSha)) throw new Error(`Invalid runtime source blob SHA: ${source.upstreamPath}`);
    if (source.localPath.startsWith('/') || source.localPath.includes('..')) throw new Error(`Unsafe runtime source local path: ${source.localPath}`);
  }
  return parsed;
}

async function verifyContent(source: RuntimeSourceEntry, content: Uint8Array, side: 'local' | 'remote'): Promise<void> {
  const actual = gitBlobSha(content);
  if (actual !== source.blobSha) {
    throw new Error(`Runtime ${side} integrity mismatch for ${source.upstreamPath}: expected ${source.blobSha}, got ${actual}`);
  }
}

export async function verifyPinnedRuntimeSources(options: { remote?: boolean } = {}): Promise<RuntimeVerification> {
  const lock = await loadRuntimeLock();
  const remote = options.remote !== false;
  const verified: RuntimeVerification['verified'] = [];

  for (const source of lock.sources) {
    const local = new Uint8Array(await readFile(resolve(source.localPath)));
    await verifyContent(source, local, 'local');

    if (remote) {
      const response = await fetch(rawUrl(lock, source.upstreamPath), { headers: { accept: 'text/plain' } });
      if (!response.ok) throw new Error(`Cannot fetch pinned runtime source ${source.upstreamPath}: HTTP ${response.status}`);
      const upstream = new Uint8Array(await response.arrayBuffer());
      await verifyContent(source, upstream, 'remote');
      if (Buffer.compare(Buffer.from(local), Buffer.from(upstream)) !== 0) {
        throw new Error(`Vendored runtime source differs byte-for-byte from pinned upstream: ${source.upstreamPath}`);
      }
    }

    verified.push({
      upstreamPath: source.upstreamPath,
      localPath: source.localPath,
      role: source.role,
      blobSha: source.blobSha,
      bytes: local.byteLength
    });
  }

  return { repository: lock.repository, commit: lock.commit, verified };
}

function sourceByRole(lock: RuntimeLock, role: RuntimeSourceEntry['role']): RuntimeSourceEntry {
  const source = lock.sources.find((candidate) => candidate.role === role);
  if (!source) throw new Error(`Runtime lock has no ${role} source`);
  return source;
}

async function runtimeValidator(): Promise<ValidateFunction> {
  if (!validatorPromise) {
    validatorPromise = (async () => {
      const lock = await loadRuntimeLock();
      const schemaSource = sourceByRole(lock, 'model-schema');
      const schema = JSON.parse(await readFile(resolve(schemaSource.localPath), 'utf8')) as object;
      const ajv = new Ajv2020({ allErrors: true, strict: true });
      return ajv.compile(schema);
    })();
  }
  return validatorPromise;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`.trim());
}

export async function validateRuntimeDescriptor(descriptor: unknown): Promise<{ valid: boolean; errors: string[] }> {
  const validate = await runtimeValidator();
  const valid = validate(descriptor) === true;
  return { valid, errors: valid ? [] : formatErrors(validate.errors) };
}

function runtimeCanonicalLabel(state: ForgeState): string {
  const candidate = state.projectSlug;
  if (candidate.length >= 3 && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(candidate)) return candidate;
  const tail = candidate.replace(/^[^A-Za-z]+/, '').replace(/[^A-Za-z0-9_.-]/g, '-') || 'Generated';
  return `Project.${tail}`;
}

export async function buildRuntimeDescriptor(state: ForgeState): Promise<Record<string, unknown>> {
  const lock = await loadRuntimeLock();
  return {
    schema_version: lock.schemaVersion,
    kind: 'allascode-model',
    model: {
      canonical_label: runtimeCanonicalLabel(state),
      semantics_path: 'manifest.yml',
      version: '0.1.0'
    },
    framework: {
      relationship: 'depends-on-allascode',
      embedded: false,
      constraint: `commit:${lock.commit}`
    },
    repository: {
      independent: true,
      boundary_invariants: [
        'model-depends-on-framework',
        'framework-does-not-depend-on-model',
        'canonical-semantics-remain-external',
        'no-domain-labels-in-framework'
      ]
    },
    conformance: {
      canonical_source: 'manifest.yml',
      profile: 'allascode-model-v1'
    }
  };
}

export async function writeRuntimeConformance(projectDirectory: string, state: ForgeState): Promise<void> {
  const lock = await loadRuntimeLock();
  const descriptor = await buildRuntimeDescriptor(state);
  const validation = await validateRuntimeDescriptor(descriptor);
  if (!validation.valid) throw new Error(`Generated AllasCode runtime descriptor is invalid: ${validation.errors.join('; ')}`);

  await writeText(join(projectDirectory, 'allascode.model.json'), `${JSON.stringify(descriptor, null, 2)}\n`);
  await writeText(join(projectDirectory, '.allascode/runtime.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await writeText(
    join(projectDirectory, 'docs/RUNTIME_CONFORMANCE.md'),
    `# Runtime conformance\n\nThis semantic model boundary is validated against the pinned canonical AllasCode independent-model contract.\n\n- Repository: \`${lock.repository}\`\n- Commit: \`${lock.commit}\`\n- Schema version: \`${lock.schemaVersion}\`\n- Schema blob: \`${sourceByRole(lock, 'model-schema').blobSha}\`\n\nThe generated model remains independent from the framework: it depends on AllasCode, AllasCode does not depend on this domain model, canonical semantics remain external to the framework, and domain labels are not embedded into framework code.\n`
  );
}

export async function readCanonicalRuntimeVector(role: 'valid-vector' | 'invalid-vector'): Promise<unknown> {
  const lock = await loadRuntimeLock();
  const source = sourceByRole(lock, role);
  return JSON.parse(await readFile(resolve(source.localPath), 'utf8')) as unknown;
}
