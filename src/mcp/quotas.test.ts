import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForgeState, SemanticArtifact } from '../shared/types.js';
import { assertArtifactQuota, assertTurnQuota } from './quotas.js';

function state(): ForgeState {
  return {
    sessionId: 'quota', projectName: 'Quota', projectSlug: 'quota', summary: '', phaseIndex: 0,
    facts: [], turns: [], artifacts: [], createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z'
  };
}

test('artifact quota blocks new identities but still permits refinement of an existing identity', () => {
  const previous = process.env.FORGER_MAX_ARTIFACTS_PER_SESSION;
  process.env.FORGER_MAX_ARTIFACTS_PER_SESSION = '1';
  try {
    const current = state();
    const existing: SemanticArtifact = { kind: 'entity', canonicalLabel: 'Order', summary: 'old', data: {} };
    current.artifacts.push(existing);
    assert.doesNotThrow(() => assertArtifactQuota(current, { ...existing, summary: 'new' }));
    assert.throws(() => assertArtifactQuota(current, { kind: 'entity', canonicalLabel: 'Payment', summary: 'new', data: {} }), /quota exceeded/);
  } finally {
    if (previous === undefined) delete process.env.FORGER_MAX_ARTIFACTS_PER_SESSION;
    else process.env.FORGER_MAX_ARTIFACTS_PER_SESSION = previous;
  }
});

test('turn quota protects the direct MCP boundary', () => {
  const previous = process.env.FORGER_MAX_TURNS_PER_SESSION;
  process.env.FORGER_MAX_TURNS_PER_SESSION = '1';
  try {
    const current = state();
    current.turns.push({ role: 'user', content: 'x', at: 'x' }, { role: 'assistant', content: 'y', at: 'x' });
    assert.throws(() => assertTurnQuota(current, { userMessage: 'a', assistantMessage: 'b', facts: [] }), /turn quota exceeded/);
  } finally {
    if (previous === undefined) delete process.env.FORGER_MAX_TURNS_PER_SESSION;
    else process.env.FORGER_MAX_TURNS_PER_SESSION = previous;
  }
});

test('artifact byte quota rejects oversized semantic payloads', () => {
  const previous = process.env.FORGER_MAX_ARTIFACT_BYTES;
  process.env.FORGER_MAX_ARTIFACT_BYTES = '128';
  try {
    assert.throws(() => assertArtifactQuota(state(), {
      kind: 'entity', canonicalLabel: 'Order', summary: 'x'.repeat(300), data: {}
    }), /byte quota/);
  } finally {
    if (previous === undefined) delete process.env.FORGER_MAX_ARTIFACT_BYTES;
    else process.env.FORGER_MAX_ARTIFACT_BYTES = previous;
  }
});
