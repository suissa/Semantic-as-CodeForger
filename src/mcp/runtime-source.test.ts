import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForgeState } from '../shared/types.js';
import { buildRuntimeDescriptor, readCanonicalRuntimeVector, validateRuntimeDescriptor, verifyPinnedRuntimeSources } from './runtime-source.js';

test('vendored canonical runtime sources match their pinned Git blob SHAs', async () => {
  const result = await verifyPinnedRuntimeSources({ remote: false });
  assert.equal(result.verified.length, 3);
  assert.ok(result.verified.every((source) => /^[0-9a-f]{40}$/.test(source.blobSha)));
});

test('canonical valid and invalid vectors preserve AllasCode schema behavior', async () => {
  const validVector = await readCanonicalRuntimeVector('valid-vector');
  const invalidVector = await readCanonicalRuntimeVector('invalid-vector');
  assert.equal((await validateRuntimeDescriptor(validVector)).valid, true);

  const invalid = await validateRuntimeDescriptor(invalidVector);
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some((error) => error.includes('must be equal to constant')));
});

test('Forger generates a conformant independent model boundary descriptor', async () => {
  const state: ForgeState = {
    sessionId: 'runtime-contract',
    projectName: 'Commerce',
    projectSlug: 'commerce',
    summary: 'Runtime contract test',
    phaseIndex: 0,
    facts: [],
    turns: [],
    artifacts: [],
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z'
  };
  const descriptor = await buildRuntimeDescriptor(state);
  const validation = await validateRuntimeDescriptor(descriptor);
  assert.deepEqual(validation, { valid: true, errors: [] });

  const framework = descriptor.framework as Record<string, unknown>;
  const repository = descriptor.repository as Record<string, unknown>;
  assert.equal(framework.embedded, false);
  assert.equal(repository.independent, true);
  assert.deepEqual(repository.boundary_invariants, [
    'model-depends-on-framework',
    'framework-does-not-depend-on-model',
    'canonical-semantics-remain-external',
    'no-domain-labels-in-framework'
  ]);
});
