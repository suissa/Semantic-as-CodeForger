import type { ForgeState, SemanticArtifact } from '../shared/types.js';

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export interface SessionQuotaConfig {
  maxArtifacts: number;
  maxTurns: number;
  maxArtifactBytes: number;
  maxMessageChars: number;
  maxFactsPerTurn: number;
  maxFactChars: number;
}

export function sessionQuotaConfig(): SessionQuotaConfig {
  return {
    maxArtifacts: positiveInteger('FORGER_MAX_ARTIFACTS_PER_SESSION', 2_000),
    maxTurns: positiveInteger('FORGER_MAX_TURNS_PER_SESSION', 500),
    maxArtifactBytes: positiveInteger('FORGER_MAX_ARTIFACT_BYTES', 524_288),
    maxMessageChars: positiveInteger('FORGER_MAX_MESSAGE_CHARS', 100_000),
    maxFactsPerTurn: positiveInteger('FORGER_MAX_FACTS_PER_TURN', 200),
    maxFactChars: positiveInteger('FORGER_MAX_FACT_CHARS', 10_000)
  };
}

export function assertSessionInput(projectName: string, summary: string): void {
  if (!projectName.trim()) throw new Error('projectName is required');
  if (projectName.length > 240) throw new Error('projectName exceeds configured safety limit');
  if (summary.length > 100_000) throw new Error('project summary exceeds configured safety limit');
}

export function assertArtifactQuota(state: ForgeState, artifact: SemanticArtifact): void {
  const config = sessionQuotaConfig();
  const exists = state.artifacts.some((candidate) => candidate.kind === artifact.kind && candidate.canonicalLabel === artifact.canonicalLabel.trim());
  if (!exists && state.artifacts.length >= config.maxArtifacts) {
    throw new Error(`Session artifact quota exceeded (${config.maxArtifacts})`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(artifact), 'utf8');
  if (bytes > config.maxArtifactBytes) {
    throw new Error(`Artifact exceeds configured byte quota (${config.maxArtifactBytes})`);
  }
}

export function assertTurnQuota(state: ForgeState, input: {
  userMessage: string;
  assistantMessage: string;
  facts: string[];
}): void {
  const config = sessionQuotaConfig();
  const recordedTurns = Math.floor(state.turns.length / 2);
  if (recordedTurns >= config.maxTurns) throw new Error(`Session turn quota exceeded (${config.maxTurns})`);
  if (input.userMessage.length > config.maxMessageChars || input.assistantMessage.length > config.maxMessageChars) {
    throw new Error(`Interview message exceeds configured character quota (${config.maxMessageChars})`);
  }
  if (input.facts.length > config.maxFactsPerTurn) throw new Error(`Facts-per-turn quota exceeded (${config.maxFactsPerTurn})`);
  if (input.facts.some((fact) => fact.length > config.maxFactChars)) throw new Error(`Interview fact exceeds configured character quota (${config.maxFactChars})`);
}
