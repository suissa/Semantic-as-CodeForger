import assert from 'node:assert/strict';
import test from 'node:test';
import { currentTenantId, runWithTenant, tenantNamespace, tenantWorkspaceRoot } from './tenant-context.js';

test('keeps the legacy local workspace root unchanged', () => {
  assert.equal(tenantWorkspaceRoot('/tmp/forger', 'local'), '/tmp/forger');
});

test('different raw tenant ids cannot collide through path sanitization', () => {
  const first = tenantNamespace('acme/team');
  const second = tenantNamespace('acme-team');
  assert.notEqual(first, second);
  assert.match(first, /^tenant-[0-9a-f]{32}$/);
  assert.match(second, /^tenant-[0-9a-f]{32}$/);
});

test('does not expose the raw tenant identifier in hosted workspace paths', () => {
  const root = tenantWorkspaceRoot('/srv/forger', 'customer@example.com');
  assert.ok(root.startsWith('/srv/forger/tenants/tenant-'));
  assert.equal(root.includes('customer@example.com'), false);
});

test('AsyncLocalStorage keeps concurrent tenant calls isolated', async () => {
  const [a, b] = await Promise.all([
    runWithTenant('tenant-a', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return currentTenantId();
    }),
    runWithTenant('tenant-b', async () => currentTenantId())
  ]);
  assert.equal(a, 'tenant-a');
  assert.equal(b, 'tenant-b');
  assert.equal(currentTenantId(), 'local');
});
