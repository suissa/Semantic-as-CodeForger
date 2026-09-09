import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyWorkspaceRetention, isWorkspaceExpired, planWorkspaceRetention } from './workspace-retention.js';

test('expiration uses the configured retention window exactly', () => {
  const now = new Date('2026-09-09T12:00:00.000Z');
  assert.equal(isWorkspaceExpired('2026-08-09T12:00:00.000Z', now, 30), true);
  assert.equal(isWorkspaceExpired('2026-08-11T12:00:00.000Z', now, 30), false);
});

test('plans legacy and tenant workspaces and only removes expired sessions when applied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forger-retention-'));
  try {
    const legacy = join(root, 'legacy-session');
    const hosted = join(root, 'tenants', 'tenant-deadbeef', 'hosted-session');
    const fresh = join(root, 'fresh-session');
    await mkdir(legacy, { recursive: true });
    await mkdir(hosted, { recursive: true });
    await mkdir(fresh, { recursive: true });
    await writeFile(join(legacy, 'forge-state.json'), JSON.stringify({ updatedAt: '2026-07-01T00:00:00.000Z' }));
    await writeFile(join(hosted, 'forge-state.json'), JSON.stringify({ updatedAt: '2026-07-02T00:00:00.000Z' }));
    await writeFile(join(fresh, 'forge-state.json'), JSON.stringify({ updatedAt: '2026-09-08T00:00:00.000Z' }));

    const plan = await planWorkspaceRetention({ root, now: new Date('2026-09-09T00:00:00.000Z'), retentionDays: 30 });
    assert.equal(plan.length, 3);
    assert.deepEqual(plan.filter((item) => item.expired).map((item) => item.sessionId).sort(), ['hosted-session', 'legacy-session']);

    const removed = await applyWorkspaceRetention(plan, root);
    assert.equal(removed.length, 2);
    await assert.rejects(() => readFile(join(legacy, 'forge-state.json')), /ENOENT/);
    assert.equal(JSON.parse(await readFile(join(fresh, 'forge-state.json'), 'utf8')).updatedAt, '2026-09-08T00:00:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
