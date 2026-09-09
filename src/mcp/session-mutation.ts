import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { LeaseDecision, SessionLeaseBackend } from '../infra/runtime-services.js';
import { sessionLeaseBackend } from '../infra/runtime-services.js';
import { currentTenantId } from './tenant-context.js';

interface MutationLeaseContext {
  backend: SessionLeaseBackend;
  scope: string;
  holder: string;
  fencingToken: number;
  expiresAt: number;
  lost?: Error;
}

const storage = new AsyncLocalStorage<MutationLeaseContext>();

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function scopeFor(sessionId: string): string {
  const digest = createHash('sha256')
    .update(currentTenantId(), 'utf8')
    .update('\0', 'utf8')
    .update(sessionId, 'utf8')
    .digest('hex');
  return `session:${digest}`;
}

function lostLeaseError(sessionId: string, fencingToken: number): Error {
  return new Error(`Session mutation lease lost: ${sessionId} fencing=${fencingToken}`);
}

export async function checkpointSessionLease(): Promise<void> {
  const context = storage.getStore();
  if (!context) return;
  if (context.lost) throw context.lost;
  const validation = await context.backend.validate(context.scope, context.holder, context.fencingToken);
  if (!validation.valid || validation.fencingToken !== context.fencingToken) {
    context.lost = new Error(`Session fencing token is stale: held=${context.fencingToken} current=${validation.fencingToken}`);
    throw context.lost;
  }
  context.expiresAt = validation.expiresAt;
}

export function currentSessionFencingToken(): number | undefined {
  return storage.getStore()?.fencingToken;
}

export async function withSessionMutationLease<T>(sessionId: string, operation: (lease: LeaseDecision) => Promise<T>): Promise<T> {
  const ttlMs = positiveInteger('FORGER_SESSION_LEASE_TTL_MS', 30_000);
  const renewMs = Math.max(25, Math.min(5_000, Math.floor(ttlMs / 3)));
  const backend = sessionLeaseBackend();
  const holder = randomUUID();
  const scope = scopeFor(sessionId);
  const lease = await backend.acquire(scope, holder, ttlMs);
  if (!lease.acquired) {
    throw new Error(`Session mutation lease busy: ${sessionId} fencing=${lease.fencingToken} expiresAt=${lease.expiresAt}`);
  }

  const context: MutationLeaseContext = {
    backend,
    scope,
    holder,
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt
  };
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const scheduleRenewal = () => {
    if (stopped || context.lost) return;
    timer = setTimeout(() => {
      void (async () => {
        try {
          const renewed = await backend.renew(scope, holder, context.fencingToken, ttlMs);
          if (!renewed.acquired || renewed.fencingToken !== context.fencingToken) {
            context.lost = lostLeaseError(sessionId, context.fencingToken);
            return;
          }
          context.expiresAt = renewed.expiresAt;
          scheduleRenewal();
        } catch (error) {
          context.lost = error instanceof Error ? error : lostLeaseError(sessionId, context.fencingToken);
        }
      })();
    }, renewMs);
    timer.unref?.();
  };

  scheduleRenewal();
  try {
    return await storage.run(context, async () => {
      const value = await operation(lease);
      await checkpointSessionLease();
      return value;
    });
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    try {
      await backend.release(scope, holder, context.fencingToken);
    } catch (error) {
      console.error('[session-lease] release failed', error);
    }
  }
}
