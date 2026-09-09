import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForgeState, SemanticArtifact } from '../shared/types.js';
import { isEligibleForAgda, validateFormalization } from './formalization.js';

function artifact(kind: SemanticArtifact['kind'], canonicalLabel: string, data: Record<string, unknown> = {}): SemanticArtifact {
  return { kind, canonicalLabel, summary: canonicalLabel, data };
}

function state(artifacts: SemanticArtifact[]): ForgeState {
  return {
    sessionId: 'proof-test', projectName: 'Proof test', projectSlug: 'proof-test', summary: '', phaseIndex: 0,
    facts: [], turns: [], artifacts, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z'
  };
}

test('generates Agda eligibility only for an explicit supported formalizable proof kind', () => {
  assert.equal(isEligibleForAgda(artifact('proof_obligation', 'Pay.idempotent', {
    formalizable: true, proofKind: 'idempotency', proposition: 'same action id changes state at most once', basisArtifact: 'Pay'
  })), true);
  assert.equal(isEligibleForAgda(artifact('proof_obligation', 'Pay.fast', {
    formalizable: true, proofKind: 'latency', proposition: 'fast', basisArtifact: 'Pay'
  })), false);
});

test('rejects status=proven when there is no formal proof evidence', () => {
  const findings = validateFormalization(state([
    artifact('constraint', 'Payment.NoDuplicateCharge'),
    artifact('proof_obligation', 'Payment.IdempotencyProof', {
      status: 'proven', formalizable: true, proofKind: 'idempotency',
      proposition: 'one action id settles at most once', basisArtifact: 'Payment.NoDuplicateCharge'
    }),
    artifact('evidence', 'Payment.IdempotencyTest', {
      evidenceClass: 'test', proves: ['Payment.IdempotencyProof']
    })
  ]));
  assert.ok(findings.some((finding) => finding.code === 'FORMAL_PROOF_CLAIM_WITHOUT_FORMAL_EVIDENCE' && finding.severity === 'error'));
});

test('accepts a proven claim only when formal proof evidence explicitly points to it', () => {
  const findings = validateFormalization(state([
    artifact('constraint', 'Payment.NoDuplicateCharge'),
    artifact('proof_obligation', 'Payment.IdempotencyProof', {
      status: 'proven', formalizable: true, proofKind: 'idempotency',
      proposition: 'one action id settles at most once', basisArtifact: 'Payment.NoDuplicateCharge'
    }),
    artifact('evidence', 'Payment.IdempotencyAgda', {
      evidenceClass: 'formal_proof', proves: ['Payment.IdempotencyProof'], checker: 'Agda'
    })
  ]));
  assert.ok(!findings.some((finding) => finding.severity === 'error'));
});

test('does not allow a runtime event to silently become formal proof evidence', () => {
  const findings = validateFormalization(state([
    artifact('evidence', 'Payment.EventObserved', {
      evidenceClass: 'runtime_event', proves: ['Payment.IdempotencyProof']
    })
  ]));
  assert.ok(findings.some((finding) => finding.code === 'EVENT_IS_NOT_FORMAL_PROOF'));
});
