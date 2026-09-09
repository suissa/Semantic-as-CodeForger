import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import YAML from 'yaml';
import type { ForgeState, SemanticArtifact } from '../shared/types.js';
import { materializeBehaviorFromPinnedBlueprint, semanticDocument } from './blueprint-source.js';
import { materializeFormalization } from './formalization.js';
import { materializeIdentityGraph } from './identity.js';
import { materializeTwoFlow, parseTwoFlow } from './twoflow.js';

interface GoldenFixture {
  action: SemanticArtifact;
  identityArtifacts: SemanticArtifact[];
  flow: SemanticArtifact;
  proof: SemanticArtifact;
  expectedTree: string[];
}

async function listFiles(root: string, dir = root): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(root, absolute));
    else if (entry.isFile()) output.push(relative(root, absolute).replace(/\\/g, '/'));
  }
  return output.sort();
}

test('golden fixture preserves current AllasCode semantics across materializers', async () => {
  const fixture = JSON.parse(await readFile(resolve('fixtures/golden/checkout-blueprint.json'), 'utf8')) as GoldenFixture;
  const root = await mkdtemp(join(tmpdir(), 'forger-golden-'));

  try {
    const actionBase = join(root, 'atomicbehavior/actions/OrderAgent-PlaceOrder/manifest.yml');
    await mkdir(dirname(actionBase), { recursive: true });
    await writeFile(actionBase, YAML.stringify(semanticDocument(fixture.action), { lineWidth: 100 }), 'utf8');
    await materializeBehaviorFromPinnedBlueprint(actionBase, fixture.action);

    const now = '2026-09-09T00:00:00.000Z';
    const state: ForgeState = {
      sessionId: 'golden',
      projectName: 'Golden Checkout',
      projectSlug: 'golden-checkout',
      summary: 'Golden materialization fixture',
      phaseIndex: 0,
      facts: [],
      turns: [],
      artifacts: [...fixture.identityArtifacts, fixture.action, fixture.flow, fixture.proof],
      createdAt: now,
      updatedAt: now
    };

    await materializeIdentityGraph(root, state);
    await materializeTwoFlow(root, fixture.flow);
    await materializeFormalization(root, fixture.proof);

    assert.deepEqual(await listFiles(root), [...fixture.expectedTree].sort());

    const manifest = YAML.parse(await readFile(actionBase, 'utf8')) as Record<string, any>;
    assert.deepEqual(manifest.events.emit, ['OrderAgent.PlaceOrder.Ok', 'OrderAgent.PlaceOrder.Error']);
    assert.equal(manifest.events.configurable_terminal_events, false);
    assert.deepEqual(manifest.events.listen, ['Checkout.Requested']);
    assert.deepEqual(manifest.self_healing, { required: true });
    assert.notDeepEqual(manifest.events.emit, ['success', 'failure']);

    const errorEvent = YAML.parse(await readFile(join(dirname(actionBase), 'events/Error.event.yml'), 'utf8')) as Record<string, any>;
    assert.equal(errorEvent.status, 'Error');
    assert.equal(errorEvent.configurable, false);
    assert.deepEqual(errorEvent.self_healing, { required: true });

    const identityGraph = YAML.parse(await readFile(join(root, 'identity/graph.yml'), 'utf8')) as Record<string, any>;
    const rule = identityGraph.identity_rules.find((item: any) => item.canonical_label === 'Order.CheckoutIdentity');
    assert.equal(rule.behavior_completing, true);
    assert.deepEqual(rule.components.map((item: any) => item.entity), ['Order', 'Customer']);

    const ast = parseTwoFlow(String(fixture.flow.data.twoFlow));
    assert.deepEqual(ast.nodes.map((node) => node.kind), ['input', 'parallel', 'error_ref', 'output']);
    assert.deepEqual(ast.nodes[1]?.children?.map((node) => node.kind), ['call', 'call']);

    const agda = await readFile(join(root, 'formalization/agda/OrderAgentPlaceOrderIdempotent.agda'), 'utf8');
    assert.match(agda, /GENERATED UNPROVEN STUB/);
    assert.match(agda, /proof = \{!!\}/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
