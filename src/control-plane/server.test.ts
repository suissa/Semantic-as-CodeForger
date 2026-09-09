import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function jsonRequest(url: string, path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

async function listen(server: import('node:http').Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: import('node:http').Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('reference control plane centralizes rate limiting, durable fencing and audit with bearer auth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forger-control-plane-'));
  const previousToken = process.env.FORGER_CONTROL_PLANE_TOKEN;
  const previousAuditRoot = process.env.FORGER_CONTROL_AUDIT_ROOT;
  const previousLeaseRoot = process.env.FORGER_CONTROL_LEASE_ROOT;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.FORGER_CONTROL_PLANE_TOKEN = 'test-control-secret';
  process.env.FORGER_CONTROL_AUDIT_ROOT = join(directory, 'audit');
  process.env.FORGER_CONTROL_LEASE_ROOT = join(directory, 'leases');
  process.env.NODE_ENV = 'test';

  const { createControlPlaneServer, resetControlPlaneStateForTests } = await import('./server.js');
  resetControlPlaneStateForTests();
  let server = createControlPlaneServer();
  let baseUrl = await listen(server);

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { leases: string }).leases, 'durable-fencing-v1');

    const unauthorized = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 1 });
    assert.equal(unauthorized.status, 401);

    const first = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 1 }, 'test-control-secret');
    const second = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 2 }, 'test-control-secret');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await first.json() as { allowed: boolean }).allowed, true);
    assert.equal((await second.json() as { allowed: boolean }).allowed, false);

    const leaseA = await jsonRequest(baseUrl, '/v1/lease/acquire', {
      scope: 'session:opaque-a', holder: 'holder-a', ttlMs: 100, now: 1_000
    }, 'test-control-secret');
    const grantA = await leaseA.json() as { acquired: boolean; fencingToken: number; expiresAt: number };
    assert.equal(grantA.acquired, true);
    assert.equal(grantA.fencingToken, 1);

    const busy = await jsonRequest(baseUrl, '/v1/lease/acquire', {
      scope: 'session:opaque-a', holder: 'holder-b', ttlMs: 100, now: 1_050
    }, 'test-control-secret');
    assert.equal((await busy.json() as { acquired: boolean }).acquired, false);

    await close(server);
    resetControlPlaneStateForTests();
    server = createControlPlaneServer();
    baseUrl = await listen(server);

    const takeover = await jsonRequest(baseUrl, '/v1/lease/acquire', {
      scope: 'session:opaque-a', holder: 'holder-b', ttlMs: 100, now: 1_101
    }, 'test-control-secret');
    const grantB = await takeover.json() as { acquired: boolean; fencingToken: number };
    assert.equal(grantB.acquired, true);
    assert.equal(grantB.fencingToken, 2, 'fencing token must survive coordinator restart');

    const stale = await jsonRequest(baseUrl, '/v1/lease/validate', {
      scope: 'session:opaque-a', holder: 'holder-a', fencingToken: 1, now: 1_102
    }, 'test-control-secret');
    const staleResult = await stale.json() as { valid: boolean; fencingToken: number };
    assert.equal(staleResult.valid, false);
    assert.equal(staleResult.fencingToken, 2);

    const current = await jsonRequest(baseUrl, '/v1/lease/validate', {
      scope: 'session:opaque-a', holder: 'holder-b', fencingToken: 2, now: 1_102
    }, 'test-control-secret');
    assert.equal((await current.json() as { valid: boolean }).valid, true);

    const staleRelease = await jsonRequest(baseUrl, '/v1/lease/release', {
      scope: 'session:opaque-a', holder: 'holder-a', fencingToken: 1
    }, 'test-control-secret');
    assert.equal((await staleRelease.json() as { released: boolean }).released, false);

    const audit = await jsonRequest(baseUrl, '/v1/audit', { request_id: 'req-12345678', status: 201 }, 'test-control-secret');
    assert.equal(audit.status, 202);
    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(directory, 'audit', `${date}.ndjson`), 'utf8');
    assert.match(content, /req-12345678/);
    assert.doesNotMatch(content, /test-control-secret/);
  } finally {
    await close(server);
    resetControlPlaneStateForTests();
    if (previousToken === undefined) delete process.env.FORGER_CONTROL_PLANE_TOKEN;
    else process.env.FORGER_CONTROL_PLANE_TOKEN = previousToken;
    if (previousAuditRoot === undefined) delete process.env.FORGER_CONTROL_AUDIT_ROOT;
    else process.env.FORGER_CONTROL_AUDIT_ROOT = previousAuditRoot;
    if (previousLeaseRoot === undefined) delete process.env.FORGER_CONTROL_LEASE_ROOT;
    else process.env.FORGER_CONTROL_LEASE_ROOT = previousLeaseRoot;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    await rm(directory, { recursive: true, force: true });
  }
});
