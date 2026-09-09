import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import YAML from 'yaml';
import type { ForgeState, SemanticArtifact, ValidationFinding } from '../shared/types.js';

const root = resolve(process.env.FORGER_WORKSPACE_ROOT ?? '.forger-workspaces');

function safeSegment(value: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error(`Unsafe path segment: ${value}`);
  return cleaned;
}

function sessionDir(sessionId: string): string {
  return join(root, safeSegment(sessionId));
}

function projectDir(sessionId: string): string {
  return join(sessionDir(sessionId), 'project');
}

function statePath(sessionId: string): string {
  return join(sessionDir(sessionId), 'forge-state.json');
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeText(path, YAML.stringify(value, { lineWidth: 100 }));
}

export async function readState(sessionId: string): Promise<ForgeState> {
  return JSON.parse(await readFile(statePath(sessionId), 'utf8')) as ForgeState;
}

export async function saveState(state: ForgeState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeText(statePath(state.sessionId), JSON.stringify(state, null, 2));
}

export async function initializeSession(input: { sessionId: string; projectName: string; summary: string }): Promise<ForgeState> {
  const projectSlug = safeSegment(input.projectName.toLowerCase());
  const now = new Date().toISOString();
  const state: ForgeState = {
    sessionId: safeSegment(input.sessionId),
    projectName: input.projectName.trim(),
    projectSlug,
    summary: input.summary.trim(),
    phaseIndex: 0,
    facts: [],
    turns: [],
    artifacts: [],
    createdAt: now,
    updatedAt: now
  };

  await mkdir(projectDir(state.sessionId), { recursive: true });
  await writeYaml(join(projectDir(state.sessionId), 'manifest.yml'), {
    api_version: 'allascode/v1',
    kind: 'Project',
    identity: { canonical_label: state.projectSlug, name: state.projectName, version: '0.1.0' },
    description: state.summary,
    generation: { source: 'Semantic-as-CodeForger', interview_driven: true }
  });
  await writeYaml(join(projectDir(state.sessionId), 'config.yml'), {
    semantics: {
      result_events: ['Ok', 'Error'],
      result_events_configurable: false,
      self_healing_required: true,
      intent_immutable: true
    },
    generation: { preserve_unknowns: true, fabricate_domain_rules: false }
  });
  await writeText(
    join(projectDir(state.sessionId), 'README.md'),
    `# ${state.projectName}\n\n${state.summary || 'AllasCode project forged from a semantic interview.'}\n\n> Generated incrementally by Semantic-as-Code Forger.\n`
  );
  await saveState(state);
  return state;
}

function artifactPath(artifact: SemanticArtifact): string {
  const label = safeSegment(artifact.canonicalLabel.replace(/\./g, '-'));
  const entity = typeof artifact.data.entity === 'string' ? safeSegment(artifact.data.entity) : 'unbound';
  const intent = typeof artifact.data.intent === 'string' ? safeSegment(artifact.data.intent) : 'unbound';
  switch (artifact.kind) {
    case 'agent': return `agents/${label}/manifest.yml`;
    case 'entity': return `entities/${label}/manifest.yml`;
    case 'property': return `entities/${entity}/properties/${label}.yml`;
    case 'type': return `types/${label}.yml`;
    case 'context': return `contexts/${label}/manifest.yml`;
    case 'intent': return `intents/${label}/manifest.yml`;
    case 'atomic_behavior': return `atomicbehavior/actions/${label}/manifest.yml`;
    case 'domain_action': return `intents/${intent}/actions/${label}/manifest.yml`;
    case 'flow': return `flows/${label}.yml`;
    case 'event': return `events/${label}.yml`;
    case 'policy': return `policies/${label}.yml`;
    case 'constraint': return `constraints/${label}.yml`;
    case 'capability': return `capabilities/${label}.yml`;
    case 'infrastructure': return `infra/${label}.yml`;
    case 'architecture_decision': return `architecture/decisions/current/${label}.md`;
  }
}

function semanticDocument(artifact: SemanticArtifact): Record<string, unknown> {
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

async function materializeBehavior(base: string, artifact: SemanticArtifact): Promise<void> {
  const dir = dirname(base);
  const invariants = Array.isArray(artifact.data.invariants) ? artifact.data.invariants : [];
  const forbidden = Array.isArray(artifact.data.forbidden) ? artifact.data.forbidden : [];
  const input = artifact.data.input ?? {};
  const output = artifact.data.output ?? {};

  await writeText(join(dir, 'README.md'), `# ${artifact.canonicalLabel}\n\n${artifact.summary}\n\n## Invariants\n${invariants.map((x) => `- ${String(x)}`).join('\n') || '- To be specified'}\n\n## Must not happen\n${forbidden.map((x) => `- ${String(x)}`).join('\n') || '- To be specified'}\n`);
  await writeYaml(join(dir, 'config.yml'), { self_healing: { required: true }, result_events: { ok: 'Ok', error: 'Error', configurable: false } });
  await writeYaml(join(dir, 'interface.yml'), { api_version: 'allascode/v1', kind: 'AtomicBehaviorInterface', behavior: { canonical_label: artifact.canonicalLabel }, input, output });
  await writeYaml(join(dir, 'schema/input.schema.yml'), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, semantic_contract: input });
  await writeYaml(join(dir, 'schema/output.schema.yml'), { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', additionalProperties: false, semantic_contract: output });
  await writeYaml(join(dir, 'events/Ok.event.yml'), { canonical_label: `${artifact.canonicalLabel}.Ok`, kind: 'result', status: 'Ok', configurable: false });
  await writeYaml(join(dir, 'events/Error.event.yml'), { canonical_label: `${artifact.canonicalLabel}.Error`, kind: 'result', status: 'Error', configurable: false, self_healing: { required: true } });
  await writeYaml(join(dir, 'specifications/invariants.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.invariants`, invariants });
  await writeYaml(join(dir, 'specifications/forbidden.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.forbidden`, forbidden });
  await writeYaml(join(dir, 'specifications/self-healing.spec.yml'), { canonical_label: `${artifact.canonicalLabel}.selfHealing`, required: true, terminal_error_return: false, fallback: 'Human-in-the-Healing-Loop' });
  await writeText(join(dir, 'implementation/README.md'), '# Implementation\n\nImplementation is intentionally deferred until the semantic contract is accepted.\n');
  await writeText(join(dir, 'SKILL.md'), `# ${artifact.canonicalLabel} AtomicAction Behavior Skill\n\nUse this behavior only when its semantic contract, invariants and required capabilities are satisfied. The listened event is injected by the flow. Successful execution emits \`${artifact.canonicalLabel}.Ok\`; failure emits \`${artifact.canonicalLabel}.Error\` and enters the mandatory self-healing pipeline. These terminal events are structural and must not be renamed or configured.\n`);
}

export async function upsertArtifact(sessionId: string, artifact: SemanticArtifact): Promise<SemanticArtifact> {
  const state = await readState(sessionId);
  const normalized: SemanticArtifact = {
    ...artifact,
    canonicalLabel: artifact.canonicalLabel.trim(),
    summary: artifact.summary.trim(),
    data: artifact.data ?? {}
  };
  if (!normalized.canonicalLabel) throw new Error('canonicalLabel is required');

  const index = state.artifacts.findIndex((a) => a.kind === normalized.kind && a.canonicalLabel === normalized.canonicalLabel);
  if (index >= 0) state.artifacts[index] = normalized;
  else state.artifacts.push(normalized);

  const relativePath = artifactPath(normalized);
  const absolutePath = join(projectDir(sessionId), relativePath);
  if (normalized.kind === 'architecture_decision') {
    await writeText(absolutePath, `# ${normalized.canonicalLabel}\n\n${normalized.summary}\n\n\`\`\`json\n${JSON.stringify(normalized.data, null, 2)}\n\`\`\`\n`);
  } else {
    await writeYaml(absolutePath, semanticDocument(normalized));
  }
  if (normalized.kind === 'atomic_behavior' || normalized.kind === 'domain_action') {
    await materializeBehavior(absolutePath, normalized);
  }

  await saveState(state);
  return normalized;
}

export async function recordTurn(input: { sessionId: string; userMessage: string; assistantMessage: string; facts: string[]; phaseComplete: boolean }): Promise<ForgeState> {
  const state = await readState(input.sessionId);
  const now = new Date().toISOString();
  state.turns.push({ role: 'user', content: input.userMessage, at: now });
  state.turns.push({ role: 'assistant', content: input.assistantMessage, at: now });
  state.facts.push(...input.facts.filter((fact) => !state.facts.includes(fact)));
  if (input.phaseComplete) state.phaseIndex += 1;
  await saveState(state);
  return state;
}

export function validateState(state: ForgeState): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  if (!state.artifacts.some((a) => a.kind === 'intent')) findings.push({ severity: 'warning', code: 'NO_INTENT', message: 'Nenhum Intent foi materializado.' });
  if (!state.artifacts.some((a) => a.kind === 'entity')) findings.push({ severity: 'warning', code: 'NO_ENTITY', message: 'Nenhuma Entity foi materializada.' });
  if (!state.artifacts.some((a) => a.kind === 'flow')) findings.push({ severity: 'warning', code: 'NO_FLOW', message: 'Nenhum Flow foi materializado.' });

  for (const artifact of state.artifacts) {
    if (artifact.kind === 'atomic_behavior' || artifact.kind === 'domain_action') {
      if (!Array.isArray(artifact.data.invariants) || artifact.data.invariants.length === 0) {
        findings.push({ severity: 'warning', code: 'BEHAVIOR_WITHOUT_INVARIANTS', message: 'Behavior sem invariantes explícitas.', artifact: artifact.canonicalLabel });
      }
      if (!Array.isArray(artifact.data.forbidden) || artifact.data.forbidden.length === 0) {
        findings.push({ severity: 'warning', code: 'BEHAVIOR_WITHOUT_FORBIDDEN', message: 'Behavior não declara o que não pode acontecer.', artifact: artifact.canonicalLabel });
      }
      if (artifact.kind === 'domain_action' && typeof artifact.data.listenEvent !== 'string') {
        findings.push({ severity: 'warning', code: 'ACTION_WITHOUT_LISTEN_EVENT', message: 'Domain Action ainda não possui evento ouvido injetado pelo fluxo.', artifact: artifact.canonicalLabel });
      }
    }
  }
  return findings;
}

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) output.push(...await listFiles(abs, rel));
    else output.push(rel);
  }
  return output.sort();
}

export async function snapshot(sessionId: string): Promise<{ state: ForgeState; tree: string[]; validation: ValidationFinding[]; projectPath: string }> {
  const state = await readState(sessionId);
  return { state, tree: await listFiles(projectDir(sessionId)), validation: validateState(state), projectPath: projectDir(sessionId) };
}

export async function finalize(sessionId: string): Promise<{ state: ForgeState; validation: ValidationFinding[] }> {
  const state = await readState(sessionId);
  const validation = validateState(state);
  const errors = validation.filter((x) => x.severity === 'error');
  if (errors.length) throw new Error(`Cannot finalize: ${errors.map((x) => x.code).join(', ')}`);
  state.finalizedAt = new Date().toISOString();
  await writeText(join(projectDir(sessionId), 'PROJECT_SUMMARY.md'), `# ${state.projectName} — Semantic Blueprint\n\n${state.summary}\n\n## Facts captured\n${state.facts.map((x) => `- ${x}`).join('\n')}\n\n## Artifacts\n${state.artifacts.map((x) => `- **${x.kind}** \`${x.canonicalLabel}\` — ${x.summary}`).join('\n')}\n`);
  await writeText(join(projectDir(sessionId), 'docs/INTERVIEW_TRACE.md'), `# Interview trace\n\n${state.turns.map((turn) => `## ${turn.role}\n\n${turn.content}`).join('\n\n')}\n`);
  await writeText(join(projectDir(sessionId), '.allascode/forge-state.json'), JSON.stringify(state, null, 2));
  await saveState(state);
  return { state, validation };
}

export function getProjectDirectory(sessionId: string): string {
  return projectDir(sessionId);
}
