import assert from 'node:assert/strict';
import test from 'node:test';
import type { ForgeState, SemanticArtifact } from '../shared/types.js';
import { validateIdentityGraph } from './identity.js';

function artifact(kind: SemanticArtifact['kind'], canonicalLabel: string, data: Record<string, unknown> = {}): SemanticArtifact {
  return { kind, canonicalLabel, summary: canonicalLabel, data };
}

function state(artifacts: SemanticArtifact[]): ForgeState {
  return {
    sessionId: 'test',
    projectName: 'Identity test',
    projectSlug: 'identity-test',
    summary: '',
    phaseIndex: 0,
    facts: [],
    turns: [],
    artifacts,
    createdAt: '2026-09-09T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z'
  };
}

test('accepts a behavior-completing identity composed from characteristics of two Entities', () => {
  const findings = validateIdentityGraph(state([
    artifact('entity', 'Customer'),
    artifact('entity', 'Merchant'),
    artifact('property', 'Customer.phone', { entity: 'Customer', canonicalCharacteristic: true }),
    artifact('property', 'Merchant.taxId', { entity: 'Merchant', canonicalCharacteristic: true }),
    artifact('relationship', 'Customer.absorbsMerchant', {
      fromEntity: 'Customer',
      toEntity: 'Merchant',
      relation: 'absorbs-for-context',
      behaviorCompleting: true,
      canonicalCharacteristic: 'Merchant.taxId',
      context: 'merchant-customer'
    }),
    artifact('identity_rule', 'Customer.identityAtMerchant', {
      entity: 'Customer',
      components: [
        { entity: 'Customer', characteristic: 'Customer.phone' },
        { entity: 'Merchant', characteristic: 'Merchant.taxId' }
      ],
      behaviorCompleting: true,
      context: 'merchant-customer',
      uniqueness: 'context-unique'
    })
  ]));

  assert.deepEqual(findings, []);
});

test('flags a behavior-completing relationship without its canonical characteristic', () => {
  const findings = validateIdentityGraph(state([
    artifact('entity', 'Order'),
    artifact('entity', 'Merchant'),
    artifact('relationship', 'Order.requiresMerchant', {
      fromEntity: 'Order',
      toEntity: 'Merchant',
      behaviorCompleting: true
    })
  ]));

  assert.ok(findings.some((finding) => finding.code === 'BEHAVIOR_COMPLETING_RELATIONSHIP_WITHOUT_CANONICAL_CHARACTERISTIC'));
});

test('flags a behavior-completing identity rule that never references another Entity', () => {
  const findings = validateIdentityGraph(state([
    artifact('entity', 'Order'),
    artifact('identity_rule', 'Order.contextIdentity', {
      entity: 'Order',
      components: [
        { entity: 'Order', characteristic: 'Order.number' },
        { entity: 'Order', characteristic: 'Order.channel' }
      ],
      behaviorCompleting: true
    })
  ]));

  assert.ok(findings.some((finding) => finding.code === 'BEHAVIOR_COMPLETING_IDENTITY_WITHOUT_EXTERNAL_ENTITY'));
});
