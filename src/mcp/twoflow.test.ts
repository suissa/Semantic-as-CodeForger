import assert from 'node:assert/strict';
import test from 'node:test';
import type { SemanticArtifact } from '../shared/types.js';
import { parseTwoFlow, renderTwoFlowMermaid, validateTwoFlow } from './twoflow.js';

test('parses AllasCode 2flow operators without changing their causal order', () => {
  const source = `-> Order.Created
->> PaymentAgent.Pay
<<- PaymentAgent.Pay.Ok
[->> Inventory.Reserve, ->> Notification.Prepare]
<- Order.Accepted`;
  const ast = parseTwoFlow(source);

  assert.deepEqual(ast.nodes.map((node) => node.kind), ['input', 'call', 'called', 'parallel', 'output']);
  assert.deepEqual(ast.nodes[3]?.children?.map((node) => node.kind), ['call', 'call']);
  assert.equal(ast.nodes[0]?.expression, 'Order.Created');
  assert.equal(ast.nodes[4]?.expression, 'Order.Accepted');
});

test('preserves try/catch and error#last-error as structural AST nodes', () => {
  const ast = parseTwoFlow(`try
->> Payment.Pay
catch
error#last-error`);
  assert.deepEqual(ast.nodes.map((node) => node.kind), ['try', 'call', 'catch', 'error_ref']);
});

test('renders parallel branches into Mermaid edges converging on the next causal node', () => {
  const mermaid = renderTwoFlowMermaid(parseTwoFlow(`[->> A, ->> B]
<- Done`));
  assert.match(mermaid, /n1_1 --> n2/);
  assert.match(mermaid, /n1_2 --> n2/);
});

test('warns when free-form flow text is passed as 2flow syntax', () => {
  const artifact: SemanticArtifact = {
    kind: 'flow',
    canonicalLabel: 'Order.Place',
    summary: 'test',
    data: { twoFlow: 'call the payment service' }
  };
  assert.ok(validateTwoFlow(artifact).some((finding) => finding.code === 'TWOFLOW_UNCLASSIFIED_STATEMENT'));
});
