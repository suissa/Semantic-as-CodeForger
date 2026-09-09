export const artifactKinds = [
  'agent',
  'entity',
  'property',
  'type',
  'context',
  'intent',
  'atomic_behavior',
  'domain_action',
  'flow',
  'event',
  'policy',
  'constraint',
  'capability',
  'infrastructure',
  'architecture_decision'
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export interface SemanticArtifact {
  kind: ArtifactKind;
  canonicalLabel: string;
  summary: string;
  data: Record<string, unknown>;
  confidence?: number;
}

export interface InterviewTurn {
  role: 'user' | 'assistant';
  content: string;
  at: string;
}

export interface ValidationFinding {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  artifact?: string;
}

export interface ForgeState {
  sessionId: string;
  projectName: string;
  projectSlug: string;
  summary: string;
  phaseIndex: number;
  facts: string[];
  turns: InterviewTurn[];
  artifacts: SemanticArtifact[];
  createdAt: string;
  updatedAt: string;
  finalizedAt?: string;
}

export interface SessionSnapshot extends ForgeState {
  phaseName: string;
  phaseCount: number;
  tree: string[];
  validation: ValidationFinding[];
}

export interface ModelTurnResult {
  acknowledgement: string;
  facts: string[];
  artifacts: SemanticArtifact[];
  phaseComplete: boolean;
  followUpQuestion?: string;
}
