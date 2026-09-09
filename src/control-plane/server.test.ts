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

test('reference control plane centralizes rate limiting and audit with bearer auth', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forger-control-plane-'));
  const previousToken = process.env.FORGER_CONTROL_PLANE_TOKEN;
  const previousAuditRoot = process.env.FORGER_CONTROL_AUDIT_ROOT;
  process.env.FORGER_CONTROL_PLANE_TOKEN = 'test-control-secret';
  process.env.FORGER_CONTROL_AUDIT_ROOT = directory;

  const { createControlPlaneServer } = await import('./server.js');
  const server = createControlPlaneServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 1 });
    assert.equal(unauthorized.status, 401);

    const first = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 1 }, 'test-control-secret');
    const second = await jsonRequest(baseUrl, '/v1/rate-limit/consume', { scope: 'tenant:a', limit: 1, windowMs: 60_000, now: 2 }, 'test-control-secret');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal((await first.json() as { allowed: boolean }).allowed, true);
    assert.equal((await second.json() as { allowed: boolean }).allowed, false);

    const audit = await jsonRequest(baseUrl, '/v1/audit', { request_id: 'req-12345678', status: 201 }, 'test-control-secret');
    assert.equal(audit.status, 202);
    const date = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(directory, `${date}.ndjson`), 'utf8');
    assert.match(content, /req-12345678/);
    assert.doesNotMatch(content, /test-control-secret/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (previousToken === undefined) delete process.env.FORGER_CONTROL_PLANE_TOKEN;
    else process.env.FORGER_CONTROL_PLANE_TOKEN = previousToken;
    if (previousAuditRoot === undefined) delete process.env.FORGER_CONTROL_AUDIT_ROOT;
    else process.env.FORGER_CONTROL_AUDIT_ROOT = previousAuditRoot;
    await rm(directory, { recursive: true, force: true });
  }
});
