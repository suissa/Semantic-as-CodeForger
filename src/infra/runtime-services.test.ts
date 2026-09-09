import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  HttpControlPlaneBackend,
  MemoryRateLimitBackend,
  MemorySessionLeaseBackend,
  assertRuntimeTopology,
  resetRuntimeServiceStateForTests
} from './runtime-services.js';

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('memory rate limiter preserves fixed-window semantics', async () => {
  resetRuntimeServiceStateForTests();
  const backend = new MemoryRateLimitBackend();
  const first = await backend.consume('tenant:a', 2, 60_000, 1_000);
  const second = await backend.consume('tenant:a', 2, 60_000, 1_001);
  const third = await backend.consume('tenant:a', 2, 60_000, 1_002);
  assert.deepEqual([first.allowed, second.allowed, third.allowed], [true, true, false]);
  assert.equal(third.remaining, 0);
  assert.equal(third.resetAt, 61_000);
});

test('session lease excludes concurrent writers and increments fencing token after takeover', async () => {
  resetRuntimeServiceStateForTests();
  const backend = new MemorySessionLeaseBackend();
  const first = await backend.acquire('session:a', 'holder-a', 100, 1_000);
  assert.equal(first.acquired, true);
  assert.equal(first.fencingToken, 1);

  const concurrent = await backend.acquire('session:a', 'holder-b', 100, 1_050);
  assert.equal(concurrent.acquired, false);
  assert.equal(concurrent.fencingToken, 1);

  const renewed = await backend.renew('session:a', 'holder-a', 1, 100, 1_060);
  assert.equal(renewed.acquired, true);
  assert.equal(renewed.fencingToken, 1);

  const takeover = await backend.acquire('session:a', 'holder-b', 100, 1_161);
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.fencingToken, 2);

  const oldValidation = await backend.validate('session:a', 'holder-a', 1, 1_162);
  const newValidation = await backend.validate('session:a', 'holder-b', 2, 1_162);
  assert.equal(oldValidation.valid, false);
  assert.equal(oldValidation.fencingToken, 2);
  assert.equal(newValidation.valid, true);

  const staleRelease = await backend.release('session:a', 'holder-a', 1);
  assert.equal(staleRelease.released, false);
  assert.equal((await backend.validate('session:a', 'holder-b', 2, 1_163)).valid, true);
});

test('multi-instance mode refuses node-local policy and lease backends', () => {
  withEnv({
    FORGER_INSTANCE_COUNT: '2',
    FORGER_WORKSPACE_BACKEND: 'local-fs',
    FORGER_RATE_LIMIT_BACKEND: 'memory',
    FORGER_AUDIT_BACKEND: 'file',
    FORGER_SESSION_LEASE_BACKEND: 'memory'
  }, () => {
    assert.throws(() => assertRuntimeTopology(), /shared-posix.*RATE_LIMIT_BACKEND=http.*AUDIT_BACKEND=http.*SESSION_LEASE_BACKEND=http/);
  });
});

test('multi-instance mode accepts shared workspace plus centralized policy and lease services', () => {
  withEnv({
    FORGER_INSTANCE_COUNT: '3',
    FORGER_WORKSPACE_BACKEND: 'shared-posix',
    FORGER_RATE_LIMIT_BACKEND: 'http',
    FORGER_AUDIT_BACKEND: 'http',
    FORGER_SESSION_LEASE_BACKEND: 'http',
    FORGER_CONTROL_PLANE_URL: 'http://127.0.0.1:8790'
  }, () => assert.doesNotThrow(() => assertRuntimeTopology()));
});

test('HTTP control-plane backend shares rate decisions, lease fencing and audit records', async () => {
  const audit: unknown[] = [];
  let count = 0;
  let leaseToken = 0;
  let active: { holder: string; token: number; expiresAt: number } | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/rate-limit/consume') {
      count += 1;
      const limit = Number(body.limit);
      res.end(JSON.stringify({ allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: 99_000 }));
      return;
    }
    if (req.url === '/v1/audit') {
      audit.push(body);
      res.statusCode = 202;
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    if (req.url === '/v1/lease/acquire') {
      const now = Number(body.now);
      if (active && active.expiresAt > now) {
        res.end(JSON.stringify({ acquired: false, fencingToken: active.token, expiresAt: active.expiresAt }));
      } else {
        leaseToken += 1;
        active = { holder: String(body.holder), token: leaseToken, expiresAt: now + Number(body.ttlMs) };
        res.end(JSON.stringify({ acquired: true, fencingToken: active.token, expiresAt: active.expiresAt }));
      }
      return;
    }
    if (req.url === '/v1/lease/renew') {
      const now = Number(body.now);
      const valid = active?.holder === body.holder && active?.token === body.fencingToken && active.expiresAt > now;
      if (valid) active!.expiresAt = now + Number(body.ttlMs);
      res.end(JSON.stringify({ acquired: Boolean(valid), fencingToken: active?.token ?? leaseToken, expiresAt: active?.expiresAt ?? 0 }));
      return;
    }
    if (req.url === '/v1/lease/validate') {
      const now = Number(body.now);
      const valid = active?.holder === body.holder && active?.token === body.fencingToken && active.expiresAt > now;
      res.end(JSON.stringify({ valid: Boolean(valid), fencingToken: active?.token ?? leaseToken, expiresAt: active?.expiresAt ?? 0 }));
      return;
    }
    if (req.url === '/v1/lease/release') {
      const released = active?.holder === body.holder && active?.token === body.fencingToken;
      if (released) active = undefined;
      res.end(JSON.stringify({ released: Boolean(released), fencingToken: leaseToken }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const backend = new HttpControlPlaneBackend({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 2_000 });
  try {
    assert.equal((await backend.consume('tenant:a', 1, 60_000, 1)).allowed, true);
    assert.equal((await backend.consume('tenant:a', 1, 60_000, 2)).allowed, false);
    const lease = await backend.acquire('session:a', 'holder-a', 100, 10);
    assert.equal(lease.fencingToken, 1);
    assert.equal((await backend.validate('session:a', 'holder-a', 1, 11)).valid, true);
    assert.equal((await backend.acquire('session:a', 'holder-b', 100, 12)).acquired, false);
    assert.equal((await backend.acquire('session:a', 'holder-b', 100, 111)).fencingToken, 2);
    assert.equal((await backend.validate('session:a', 'holder-a', 1, 112)).valid, false);
    await backend.append({ request_id: 'req-12345678', status: 200 });
    assert.deepEqual(audit, [{ request_id: 'req-12345678', status: 200 }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
