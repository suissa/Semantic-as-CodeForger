import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import YAML from 'yaml';
import type { ForgeState, SemanticArtifact, ValidationFinding } from '../shared/types.js';

export const formalizableProofKinds = [
  'determinism',
  'identity_preservation',
  'idempotency',
  'ordering',
  'authorization_monotonicity',
  'behavior_composition',
  'exactly_once_semantics'
] as const;

function str(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function safeName(label: string): string {
  const pieces = label.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((piece) => `${piece[0]?.toUpperCase() ?? ''}${piece.slice(1)}`);
  return pieces.join('') || 'Obligation';
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeText(path, YAML.stringify(value, { lineWidth: 110 }));
}

export function isEligibleForAgda(artifact: SemanticArtifact): boolean {
  if (artifact.kind !== 'proof_obligation' || artifact.data.formalizable !== true) return false;
  const proofKind = str(artifact.data, 'proofKind');
  return Boolean(proofKind && (formalizableProofKinds as readonly string[]).includes(proofKind));
}

export function validateFormalization(state: ForgeState): ValidationFinding[] {
  const findings: ValidationFinding[] = [];
  const artifacts = new Set(state.artifacts.map((artifact) => artifact.canonicalLabel));
  const evidence = state.artifacts.filter((artifact) => artifact.kind === 'evidence');

  for (const artifact of state.artifacts) {
    if (artifact.kind === 'proof_obligation') {
      const proposition = str(artifact.data, 'proposition');
      const basis = str(artifact.data, 'basisArtifact');
      const proofKind = str(artifact.data, 'proofKind');
      const status = str(artifact.data, 'status') ?? 'unproven';

      if (!proposition) findings.push({ severity: 'warning', code: 'PROOF_OBLIGATION_WITHOUT_PROPOSITION', message: 'Proof obligation precisa declarar a proposição que deve ser provada.', artifact: artifact.canonicalLabel });
      if (!basis) findings.push({ severity: 'warning', code: 'PROOF_OBLIGATION_WITHOUT_BASIS', message: 'Proof obligation precisa apontar o invariant/law/rule que a origina em data.basisArtifact.', artifact: artifact.canonicalLabel });
      else if (!artifacts.has(basis)) findings.push({ severity: 'warning', code: 'PROOF_OBLIGATION_UNKNOWN_BASIS', message: `A base semântica da proof obligation ainda não foi materializada: ${basis}.`, artifact: artifact.canonicalLabel });

      if (artifact.data.formalizable === true && (!proofKind || !(formalizableProofKinds as readonly string[]).includes(proofKind))) {
        findings.push({ severity: 'warning', code: 'PROOF_KIND_NOT_ELIGIBLE_FOR_AGDA_STUB', message: `A obrigação foi marcada formalizable, mas proofKind não está na lista explicitamente suportada: ${proofKind ?? 'missing'}.`, artifact: artifact.canonicalLabel });
      }

      if (status === 'proven') {
        const provingEvidence = evidence.filter((candidate) => strings(candidate.data.proves).includes(artifact.canonicalLabel));
        const formalProof = provingEvidence.some((candidate) => str(candidate.data, 'evidenceClass') === 'formal_proof');
        if (!formalProof) {
          findings.push({ severity: 'error', code: 'FORMAL_PROOF_CLAIM_WITHOUT_FORMAL_EVIDENCE', message: 'Uma obrigação só pode ter status=proven quando existe Evidence classificada como formal_proof que referencia explicitamente essa obrigação.', artifact: artifact.canonicalLabel });
        }
      }
    }

    if (artifact.kind === 'evidence') {
      const proves = strings(artifact.data.proves);
      const evidenceClass = str(artifact.data, 'evidenceClass');
      if (proves.length === 0) findings.push({ severity: 'warning', code: 'EVIDENCE_WITHOUT_PROPOSITION', message: 'Evidence deve declarar quais proof obligations/proposições ela suporta em data.proves.', artifact: artifact.canonicalLabel });
      if (!evidenceClass) findings.push({ severity: 'warning', code: 'EVIDENCE_WITHOUT_CLASS', message: 'Evidence deve declarar evidenceClass (formal_proof, model_check, test, runtime_observation ou review).', artifact: artifact.canonicalLabel });
      if (evidenceClass === 'event' || evidenceClass === 'runtime_event') {
        findings.push({ severity: 'warning', code: 'EVENT_IS_NOT_FORMAL_PROOF', message: 'Um evento de runtime pode ser observação/evidência operacional, mas não deve ser classificado como prova formal por si só.', artifact: artifact.canonicalLabel });
      }
      if (evidenceClass === 'formal_proof' && !str(artifact.data, 'checker')) {
        findings.push({ severity: 'warning', code: 'FORMAL_EVIDENCE_WITHOUT_CHECKER', message: 'Evidence formal deve registrar o checker/proof assistant que verificou o artefato.', artifact: artifact.canonicalLabel });
      }
    }
  }

  return findings;
}

export async function materializeFormalization(projectDirectory: string, artifact: SemanticArtifact): Promise<void> {
  if (artifact.kind === 'proof_obligation') {
    const label = artifact.canonicalLabel.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\./g, '-');
    const status = str(artifact.data, 'status') ?? 'unproven';
    const document = {
      api_version: 'allascode/v1',
      kind: 'ProofObligation',
      identity: { canonical_label: artifact.canonicalLabel },
      description: artifact.summary,
      status,
      proposition: str(artifact.data, 'proposition') ?? null,
      basis_artifact: str(artifact.data, 'basisArtifact') ?? null,
      proof_kind: str(artifact.data, 'proofKind') ?? null,
      formalizable: artifact.data.formalizable === true,
      evidence: strings(artifact.data.evidence),
      rule: 'unproven-until-explicit-evidence'
    };
    await writeYaml(join(projectDirectory, 'formalization/obligations', `${label}.yml`), document);

    if (isEligibleForAgda(artifact)) {
      const moduleName = safeName(artifact.canonicalLabel);
      const proposition = str(artifact.data, 'proposition') ?? 'Proposition not yet encoded';
      const basis = str(artifact.data, 'basisArtifact') ?? 'unknown';
      await writeText(
        join(projectDirectory, 'formalization/agda', `${moduleName}.agda`),
        `module ${moduleName} where\n\n-- GENERATED UNPROVEN STUB. The hole below is intentional.\n-- Basis: ${basis}\n-- Proposition: ${proposition.replace(/\r?\n/g, ' ')}\n\npostulate\n  Proposition : Set\n\nproof : Proposition\nproof = {!!}\n`
      );
    }
  }

  if (artifact.kind === 'evidence') {
    const label = artifact.canonicalLabel.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/\./g, '-');
    await writeYaml(join(projectDirectory, 'formalization/evidence', `${label}.prov.yml`), {
      api_version: 'allascode/v1',
      kind: 'Evidence',
      identity: { canonical_label: artifact.canonicalLabel },
      description: artifact.summary,
      evidence_class: str(artifact.data, 'evidenceClass') ?? null,
      proves: strings(artifact.data.proves),
      checker: str(artifact.data, 'checker') ?? null,
      artifact_hash: str(artifact.data, 'artifactHash') ?? null,
      source: str(artifact.data, 'source') ?? null
    });
  }
}
