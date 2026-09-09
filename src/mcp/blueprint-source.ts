import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import type { SemanticArtifact } from '../shared/types.js';

export interface BlueprintSourceEntry {
  path: string;
  blobSha: string;
  role: string;
}

export interface BlueprintCompatibility {
  profile: string;
  terminalEvents: ['Ok', 'Error'];
  terminalEventsConfigurable: false;
  legacyTerminalAliasesAllowed: false;
  selfHealingRequired: true;
  intentImmutable: true;
  preserveUnknowns: true;
  fabricateDomainRules: false;
  note: string;
}

export interface BlueprintLock {
  version: number;
  repository: string;
  commit: string;
  root: string;
  sources: BlueprintSourceEntry[];
  compatibility: BlueprintCompatibility;
}

export interface BlueprintVerification {
  repository: string;
  commit: string;
  verified: Array<{ path: string; role: string; blobSha: string; bytes: number }>;
}

const lockPath = resolve(process.env.FORGER_BLUEPRINT_LOCK ?? 'blueprint.lock.json');
const cacheRoot = resolve(process.env.FORGER_BLUEPRINT_CACHE ?? '.forger-cache/blueprint');

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeText(path, YAML.stringify(value, { lineWidth: 100 }));
}

export async function loadBlueprintLock(): Promise<BlueprintLock> {
  const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as BlueprintLock;
  if (parsed.version !== 1) throw new Error(`Unsupported Blueprint lock version: ${parsed.version}`);
  if (!/^[0-9a-f]{40}$/.test(parsed.commit)) throw new Error('Blueprint lock must pin a full 40-character commit SHA');
  if (!parsed.repository.includes('/')) throw new Error('Blueprint lock repository must be owner/name');
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) throw new Error('Blueprint lock has no pinned sources');
  if (parsed.compatibility.terminalEvents.join(',') !== 'Ok,Error') throw new Error('Compatibility profile must preserve structural Ok/Error terminal events');
  if (parsed.compatibility.terminalEventsConfigurable !== false) throw new Error('Terminal events must remain non-configurable');
  if (parsed.compatibility.legacyTerminalAliasesAllowed !== false) throw new Error('Legacy success/failure aliases must not become generated terminal events');
  return parsed;
}

export function gitBlobSha(content: Uint8Array): string {
  const header = Buffer.from(`blob ${content.byteLength}\0`, 'utf8');
  return createHash('sha1').update(header).update(content).digest('hex');
}

function rawUrl(lock: BlueprintLock, path: string): string {
  return `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

async function fetchSource(lock: BlueprintLock, source: BlueprintSourceEntry): Promise<Uint8Array> {
  const response = await fetch(rawUrl(lock, source.path), { headers: { accept: 'text/plain' } });
  if (!response.ok) throw new Error(`Cannot fetch pinned Blueprint source ${source.path}: HTTP ${response.status}`);
  const content = new Uint8Array(await response.arrayBuffer());
  const actual = gitBlobSha(content);
  if (actual !== source.blobSha) {
    throw new Error(`Blueprint source integrity mismatch for ${source.path}: expected ${source.blobSha}, got ${actual}`);
  }
  return content;
}

export async function verifyPinnedBlueprintSources(options: { writeCache?: boolean } = {}): Promise<BlueprintVerification> {
  const lock = await loadBlueprintLock();
  const verified: BlueprintVerification['verified'] = [];
  for (const source of lock.sources) {
    const content = await fetchSource(lock, source);
    if (options.writeCache) {
      const target = join(cacheRoot, lock.commit, source.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    verified.push({ path: source.path, role: source.role, blobSha: source.blobSha, bytes: content.byteLength });
  }
  return { repository: lock.repository, commit: lock.commit, verified };
}

export async function writeBlueprintProvenance(projectDirectory: string): Promise<BlueprintLock> {
  const lock = await loadBlueprintLock();
  await writeText(join(projectDirectory, '.allascode/blueprint.lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  await writeText(
    join(projectDirectory, 'docs/BLUEPRINT_SOURCE.md'),
    `# Blueprint source\n\nThis project was materialized against a pinned AllasCode Blueprint source.\n\n- Repository: \`${lock.repository}\`\n- Commit: \`${lock.commit}\`\n- Compatibility profile: \`${lock.compatibility.profile}\`\n\n## Semantic compatibility overlay\n\nThe pinned upstream source supplies structure and provenance. Current AllasCode semantics remain authoritative: terminal Action consequences are exactly \`.Ok\` and \`.Error\`, are not configurable, and \`.Error\` enters mandatory self-healing. Legacy \`success/failure\` examples in older Blueprint prose are never emitted as structural terminal events.\n\n## Pinned source files\n\n${lock.sources.map((source) => `- \`${source.path}\` — ${source.role} — \`${source.blobSha}\``).join('\n')}\n`
  );
  return lock;
}

export function semanticDocument(artifact: SemanticArtifact): Record<string, unknown> {
  const document: Record<string, unknown> = {
    api_version: 'allascode/v1',
    kind: artifact.kind,
    identity: { canonical_label: artifact.canonicalLabel, version: '0.1.0' },
    description: artifact.summary,
    ...artifact.data
  };

  if (artifact.kind === 'atomic_behavior' || artifact.kind === 'domain_action') {
    document.events = {
      listen: typeof artifact.data.listenEvent === 'string' ? [artifact.data.listenEvent] : [],
      emit: [`${artifact.canonicalLabel}.Ok`, `${artifact.canonicalLabel}.Error`],
      configurable_terminal_events: false
    };
    document.self_healing = { required: true };
  }
  return document;
}

export async function materializeBehaviorFromPinnedBlueprint(base: string, artifact: SemanticArtifact): Promise<void> {
  const lock = await loadBlueprintLock();
  const dir = dirname(base);
  const invariants = Array.isArray(artifact.data.invariants) ? artifact.data.invariants : [];
  const forbidden = Array.isArray(artifact.data.forbidden) ? artifact.data.forbidden : [];
  const input = artifact.data.input ?? {};
  const output = artifact.data.output ?? {};
  const source = { repository: lock.repository, commit: lock.commit, compatibility_profile: lock.compatibility.profile };

  await writeText(join(dir, 'README.md'), `# ${artifact.canonicalLabel}\n\n${artifact.summary}\n\n> Structure derived from pinned AllasCode-Blueprint \`${lock.commit}\`; current semantic compatibility profile \`${lock.compatibility.profile}\`.\n\n## Invariants\n${invariants.map((x) => `- ${String(x)}`).join('\n') || '- To be specified'}\n\n## Must not happen\n${forbidden.map((x) => `- ${String(x)}`).join('\n') || '- To be specified'}\n`);
  await writeYaml(join(dir, 'config.yml'), { source, self_healing: { required: true }, result_events: { ok: 'Ok', error: 'Error', configurable: false } });
  await writeYaml(join(dir, 'interface.yml'), { api_version: 'allascode/v1', kind: 'AtomicBehaviorInterface', source, behavior: { canonical_label: artifact.canonicalLabel }, input, output });
  await writeYaml(join(dir, 'schema/input.schema.yml'), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, source, semantic_contract: input });
  await writeYaml(join(dir, 'schema/output.schema.yml'), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, source, semantic_contract: output });
  await writeYaml(join(dir, 'events/Ok.event.yml'), { canonical_label: `${artifact.canonicalLabel}.Ok`, kind: 'result', status: 'Ok', configurable: false, source });
  await writeYaml(join(dir, 'events/Error.event.yml'), { canonical_label: `${artifact.canonicalLabel}.Error`, kind: 'result', status: 'Error', configurable: false, self_healing: { required: true }, source });
  await writeYaml(join(dir, 'specifications/invariants.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.invariants`, invariants, source });
  await writeYaml(join(dir, 'specifications/forbidden.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.forbidden`, forbidden, source });
  await writeYaml(join(dir, 'specifications/self-healing.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.selfHealing`, required: true, terminal_error_return: false, fallback: 'Human-in-the-Healing-Loop', source });
  await writeText(join(dir, 'implementation/README.md'), '# Implementation\n\nImplementation is intentionally deferred until the semantic contract is accepted.\n');
  await writeText(join(dir, 'SKILL.md'), `# ${artifact.canonicalLabel} AtomicAction Behavior Skill\n\nUse this behavior only when its semantic contract, invariants and required capabilities are satisfied. The listened event is injected by the flow. Successful execution emits \`${artifact.canonicalLabel}.Ok\`; failure emits \`${artifact.canonicalLabel}.Error\` and enters the mandatory self-healing pipeline. These terminal events are structural and must not be renamed or configured.\n\nBlueprint source: \`${lock.repository}@${lock.commit}\`.\n`);
}
