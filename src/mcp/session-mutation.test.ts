import assert from 'node:assert/strict';
import test from 'node:test';
import { resetRuntimeServiceStateForTests } from '../infra/runtime-services.js';
import { currentSessionFencingToken, withSessionMutationLease } from './session-mutation.js';
import { runWithTenant } from './tenant-context.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('same tenant/session permits only one active mutating operation', async () => {
  resetRuntimeServiceStateForTests();
  const previousBackend = process.env.FORGER_SESSION_LEASE_BACKEND;
  const previousTtl = process.env.FORGER_SESSION_LEASE_TTL_MS;
  process.env.FORGER_SESSION_LEASE_BACKEND = 'memory';
  process.env.FORGER_SESSION_LEASE_TTL_MS = '10000';

  const entered = deferred<void>();
  const release = deferred<void>();

  try {
    await runWithTenant('tenant-a', async () => {
      const first = withSessionMutationLease('session-a', async () => {
        entered.resolve(undefined);
        await release.promise;
        return currentSessionFencingToken();
      });
      await entered.promise;

      await assert.rejects(
        () => withSessionMutationLease('session-a', async () => 'second'),
        /Session mutation lease busy/
      );

      release.resolve(undefined);
      assert.equal(await first, 1);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.FORGER_SESSION_LEASE_BACKEND;
    else process.env.FORGER_SESSION_LEASE_BACKEND = previousBackend;
    if (previousTtl === undefined) delete process.env.FORGER_SESSION_LEASE_TTL_MS;
    else process.env.FORGER_SESSION_LEASE_TTL_MS = previousTtl;
  }
});

test('sequential mutations receive monotonically increasing fencing tokens', async () => {
  resetRuntimeServiceStateForTests();
  const previousBackend = process.env.FORGER_SESSION_LEASE_BACKEND;
  process.env.FORGER_SESSION_LEASE_BACKEND = 'memory';

  try {
    await runWithTenant('tenant-a', async () => {
      const first = await withSessionMutationLease('session-a', async () => currentSessionFencingToken());
      const second = await withSessionMutationLease('session-a', async () => currentSessionFencingToken());
      assert.equal(first, 1);
      assert.equal(second, 2);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.FORGER_SESSION_LEASE_BACKEND;
    else process.env.FORGER_SESSION_LEASE_BACKEND = previousBackend;
  }
});

test('different sessions do not block each other', async () => {
  resetRuntimeServiceStateForTests();
  const previousBackend = process.env.FORGER_SESSION_LEASE_BACKEND;
  process.env.FORGER_SESSION_LEASE_BACKEND = 'memory';

  try {
    await runWithTenant('tenant-a', async () => {
      const gate = deferred<void>();
      const first = withSessionMutationLease('session-a', async () => {
        await gate.promise;
        return currentSessionFencingToken();
      });
      const second = await withSessionMutationLease('session-b', async () => currentSessionFencingToken());
      gate.resolve(undefined);
      assert.equal(await first, 1);
      assert.equal(second, 1);
    });
  } finally {
    if (previousBackend === undefined) delete process.env.FORGER_SESSION_LEASE_BACKEND;
    else process.env.FORGER_SESSION_LEASE_BACKEND = previousBackend;
  }
});
