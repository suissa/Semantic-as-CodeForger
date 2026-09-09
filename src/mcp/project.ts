import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import YAML from 'yaml';
import type { ForgeState, SemanticArtifact, ValidationFinding } from '../shared/types.js';
import { materializeBehaviorFromPinnedBlueprint, semanticDocument, writeBlueprintProvenance } from './blueprint-source.js';
import { materializeFormalization, validateFormalization } from './formalization.js';
import { materializeIdentityGraph, validateIdentityGraph } from './identity.js';
import { appendInterviewEvent, exportInterviewEventLog, initializeInterviewEventLog, replayInterviewState } from './session-events.js';
import { materializeTwoFlow, validateTwoFlow } from './twoflow.js';

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

async function readSnapshotCache(sessionId: string): Promise<ForgeState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(sessionId), 'utf8')) as ForgeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function readState(sessionId: string): Promise<ForgeState> {
  const snapshot = await readSnapshotCache(sessionId);
  const replayed = await replayInterviewState(sessionDir(sessionId));

  if (!replayed && !snapshot) throw new Error(`Unknown Forger session: ${sessionId}`);
  if (!replayed) return snapshot!;
  if (!snapshot) return replayed;

  return {
    ...replayed,
    repository: snapshot.repository,
    updatedAt: snapshot.updatedAt > replayed.updatedAt ? snapshot.updatedAt : replayed.updatedAt
  };
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

  const directory = projectDir(state.sessionId);
  await mkdir(directory, { recursive: true });
  const blueprint = await writeBlueprintProvenance(directory);
  await writeYaml(join(directory, 'manifest.yml'), {
    api_version: 'allascode/v1',
    kind: 'Project',
    identity: { canonical_label: state.projectSlug, name: state.projectName, version: '0.1.0' },
    description: state.summary,
    generation: {
      source: 'Semantic-as-CodeForger',
      interview_driven: true,
      blueprint: {
        repository: blueprint.repository,
        commit: blueprint.commit,
        compatibility_profile: blueprint.compatibility.profile
      }
    }
  });
  await writeYaml(join(directory, 'config.yml'), {
    semantics: {
      result_events: blueprint.compatibility.terminalEvents,
      result_events_configurable: blueprint.compatibility.terminalEventsConfigurable,
      legacy_terminal_aliases_allowed: blueprint.compatibility.legacyTerminalAliasesAllowed,
      self_healing_required: blueprint.compatibility.selfHealingRequired,
      intent_immutable: blueprint.compatibility.intentImmutable,
      semantic_identity_graph: true,
      cross_entity_identity: true,
      twoflow_ast: true,
      formal_proof_claim_requires_evidence: true,
      interview_state_event_sourced: true
    },
    generation: {
      preserve_unknowns: blueprint.compatibility.preserveUnknowns,
      fabricate_domain_rules: blueprint.compatibility.fabricateDomainRules,
      blueprint_commit: blueprint.commit
    }
  });
  await writeText(
    join(directory, 'README.md'),
    `# ${state.projectName}\n\n${state.summary || 'AllasCode project forged from a semantic interview.'}\n\n> Generated incrementally by Semantic-as-Code Forger against pinned AllasCode-Blueprint \`${blueprint.commit}\`.\n`
  );
  await materializeIdentityGraph(directory, state);
  await initializeInterviewEventLog(sessionDir(state.sessionId), state);
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
    case 'relationship': return `identity/relationships/${label}.yml`;
    case 'identity_rule': return `identity/rules/${label}.yml`;
    case 'proof_obligation': return `formalization/obligations/${label}.yml`;
    case 'evidence': return `formalization/evidence/${label}.prov.yml`;
    case 'architecture_decision': return `architecture/decisions/current/${label}.md`;
  }
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
  if (normalized.kind === 'atomic_behavior' || normalized.kind === 'domain_action') await materializeBehaviorFromPinnedBlueprint(absolutePath, normalized);
  if (normalized.kind === 'entity' || normalized.kind === 'property' || normalized.kind === 'relationship' || normalized.kind === 'identity_rule') await materializeIdentityGraph(projectDir(sessionId), state);
  if (normalized.kind === 'flow') await materializeTwoFlow(projectDir(sessionId), normalized);
  if (normalized.kind === 'proof_obligation' || normalized.kind === 'evidence') await materializeFormalization(projectDir(sessionId), normalized);

  await appendInterviewEvent(sessionDir(sessionId), { type: 'ArtifactUpserted', data: { artifact: normalized } });
  await saveState(state);
  return normalized;
}

export async function recordTurn(input: { sessionId: string; userMessage: string; assistantMessage: string; facts: string[]; phaseComplete: boolean }): Promise<ForgeState> {
  const state = await readState(input.sessionId);
  const event = await appendInterviewEvent(sessionDir(input.sessionId), {
    type: 'TurnRecorded',
    data: {
      userMessage: input.userMessage,
      assistantMessage: input.assistantMessage,
      facts: input.facts,
      phaseAdvanced: input.phaseComplete
    }
  });
  state.turns.push({ role: 'user', content: input.userMessage, at: event.at });
  state.turns.push({ role: 'assistant', content: input.assistantMessage, at: event.at });
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
      if (!Array.isArray(artifact.data.invariants) || artifact.data.invariants.length === 0) findings.push({ severity: 'warning', code: 'BEHAVIOR_WITHOUT_INVARIANTS', message: 'Behavior sem invariantes explícitas.', artifact: artifact.canonicalLabel });
      if (!Array.isArray(artifact.data.forbidden) || artifact.data.forbidden.length === 0) findings.push({ severity: 'warning', code: 'BEHAVIOR_WITHOUT_FORBIDDEN', message: 'Behavior não declara o que não pode acontecer.', artifact: artifact.canonicalLabel });
      if (artifact.kind === 'domain_action' && typeof artifact.data.listenEvent !== 'string') findings.push({ severity: 'warning', code: 'ACTION_WITHOUT_LISTEN_EVENT', message: 'Domain Action ainda não possui evento ouvido injetado pelo fluxo.', artifact: artifact.canonicalLabel });
    }
    if (artifact.kind === 'flow') findings.push(...validateTwoFlow(artifact));
  }
  findings.push(...validateIdentityGraph(state));
  findings.push(...validateFormalization(state));
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
  await materializeIdentityGraph(projectDir(sessionId), state);
  for (const flow of state.artifacts.filter((artifact) => artifact.kind === 'flow')) await materializeTwoFlow(projectDir(sessionId), flow);
  for (const artifact of state.artifacts.filter((item) => item.kind === 'proof_obligation' || item.kind === 'evidence')) await materializeFormalization(projectDir(sessionId), artifact);
  await writeText(join(projectDir(sessionId), 'PROJECT_SUMMARY.md'), `# ${state.projectName} — Semantic Blueprint\n\n${state.summary}\n\n## Facts captured\n${state.facts.map((x) => `- ${x}`).join('\n')}\n\n## Artifacts\n${state.artifacts.map((x) => `- **${x.kind}** \`${x.canonicalLabel}\` — ${x.summary}`).join('\n')}\n`);
  await writeText(join(projectDir(sessionId), 'docs/INTERVIEW_TRACE.md'), `# Interview trace\n\n${state.turns.map((turn) => `## ${turn.role}\n\n${turn.content}`).join('\n\n')}\n`);
  await appendInterviewEvent(sessionDir(sessionId), { type: 'SessionFinalized', data: { finalizedAt: state.finalizedAt } });
  await exportInterviewEventLog(sessionDir(sessionId), projectDir(sessionId));
  await writeText(join(projectDir(sessionId), '.allascode/forge-state.json'), JSON.stringify(state, null, 2));
  await saveState(state);
  return { state, validation };
}

export function getProjectDirectory(sessionId: string): string {
  return projectDir(sessionId);
}
