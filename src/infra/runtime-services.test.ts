import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import {
  HttpControlPlaneBackend,
  MemoryRateLimitBackend,
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

test('multi-instance mode refuses node-local policy backends', () => {
  withEnv({
    FORGER_INSTANCE_COUNT: '2',
    FORGER_WORKSPACE_BACKEND: 'local-fs',
    FORGER_RATE_LIMIT_BACKEND: 'memory',
    FORGER_AUDIT_BACKEND: 'file'
  }, () => {
    assert.throws(() => assertRuntimeTopology(), /shared-posix.*RATE_LIMIT_BACKEND=http.*AUDIT_BACKEND=http/);
  });
});

test('multi-instance mode accepts shared workspace plus centralized policy services', () => {
  withEnv({
    FORGER_INSTANCE_COUNT: '3',
    FORGER_WORKSPACE_BACKEND: 'shared-posix',
    FORGER_RATE_LIMIT_BACKEND: 'http',
    FORGER_AUDIT_BACKEND: 'http',
    FORGER_CONTROL_PLANE_URL: 'http://127.0.0.1:8790'
  }, () => assert.doesNotThrow(() => assertRuntimeTopology()));
});

test('HTTP control-plane backend shares rate decisions and forwards audit records', async () => {
  const audit: unknown[] = [];
  let count = 0;
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
    await backend.append({ request_id: 'req-12345678', status: 200 });
    assert.deepEqual(audit, [{ request_id: 'req-12345678', status: 200 }]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
