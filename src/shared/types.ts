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
  'relationship',
  'identity_rule',
  'proof_obligation',
  'evidence',
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

export type PullRequestPolicy = 'manual' | 'after_publish';

export interface RepositoryTarget {
  provider: 'github';
  repository: string;
  baseBranch: string;
  targetBranch: string;
  pathPrefix: string;
  pullRequestPolicy: PullRequestPolicy;
  pullRequestDraft: boolean;
  configuredAt: string;
}

export interface RepositoryReviewFile {
  path: string;
  status: 'added' | 'modified' | 'unchanged';
  bytes: number;
  sha: string;
  remoteSha?: string;
}

export interface RepositoryReview {
  token: string;
  generatedAt: string;
  baseSha: string;
  baseTreeSha: string;
  parentBranch: string;
  files: RepositoryReviewFile[];
  counts: {
    added: number;
    modified: number;
    unchanged: number;
  };
  publishedAt?: string;
  commitSha?: string;
}

export interface RepositoryPullRequest {
  number: number;
  url: string;
  state: 'open' | 'closed';
  title: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
  createdAt: string;
  reusedExisting: boolean;
}

export interface RepositoryState {
  target?: RepositoryTarget;
  review?: RepositoryReview;
  pullRequest?: RepositoryPullRequest;
  pullRequestError?: string;
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
  repository?: RepositoryState;
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
