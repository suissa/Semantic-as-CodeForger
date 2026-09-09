import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function textPayload<T>(result: unknown): T {
  const content = (result as { content?: unknown }).content;
  assert.ok(Array.isArray(content));
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  assert.equal(first?.type, 'text');
  assert.equal(typeof first?.text, 'string');
  return JSON.parse(first!.text as string) as T;
}

test('MCP stdio boundary exposes governed tenant-scoped tools and materializes a Domain Action', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'forger-mcp-conformance-'));
  const client = new Client({ name: 'forger-conformance-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/mcp/server.ts'],
    cwd: process.cwd(),
    env: { ...process.env, FORGER_WORKSPACE_ROOT: workspace } as Record<string, string>
  });

  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    for (const required of [
      'forger_session_init',
      'forger_artifact_upsert',
      'forger_session_record_turn',
      'forger_session_snapshot',
      'forger_finalize',
      'forger_repository_target_set',
      'forger_repository_review',
      'forger_repository_publish',
      'forger_repository_pull_request_create'
    ]) assert.ok(names.includes(required), `missing MCP tool: ${required}`);

    for (const tool of listed.tools) {
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      assert.ok(required.includes('tenantId'), `${tool.name} does not require tenantId`);
    }

    const tenantId = 'tenant-conformance';
    const sessionId = 'conformance-session';
    textPayload(await client.callTool({
      name: 'forger_session_init',
      arguments: { tenantId, sessionId, projectName: 'Conformance', summary: 'MCP boundary test' }
    }));

    textPayload(await client.callTool({
      name: 'forger_artifact_upsert',
      arguments: {
        tenantId,
        sessionId,
        artifact: {
          kind: 'domain_action',
          canonicalLabel: 'OrderAgent.PlaceOrder',
          summary: 'Place an order.',
          data: {
            intent: 'PlaceOrder',
            listenEvent: 'Checkout.Requested',
            invariants: ['same request cannot establish two orders'],
            forbidden: ['custom terminal status names'],
            input: { order: 'Order' },
            output: { order: 'Order' }
          }
        }
      }
    }));

    const snapshot = textPayload<{ tree: string[]; state: { artifacts: Array<{ canonicalLabel: string }> } }>(await client.callTool({
      name: 'forger_session_snapshot',
      arguments: { tenantId, sessionId }
    }));

    assert.ok(snapshot.state.artifacts.some((artifact) => artifact.canonicalLabel === 'OrderAgent.PlaceOrder'));
    assert.ok(snapshot.tree.includes('intents/PlaceOrder/actions/OrderAgent-PlaceOrder/events/Ok.event.yml'));
    assert.ok(snapshot.tree.includes('intents/PlaceOrder/actions/OrderAgent-PlaceOrder/events/Error.event.yml'));
    assert.ok(snapshot.tree.includes('intents/PlaceOrder/actions/OrderAgent-PlaceOrder/specifications/self-healing.spec.yml'));

    await assert.rejects(
      () => client.callTool({ name: 'forger_session_snapshot', arguments: { sessionId } }),
      /tenantId|required/i
    );
  } finally {
    await client.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});
