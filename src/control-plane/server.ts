import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface WindowEntry {
  windowStart: number;
  count: number;
}

interface LeaseState {
  highestFencingToken: number;
  holder?: string;
  fencingToken?: number;
  expiresAt?: number;
}

const windows = new Map<string, WindowEntry>();
const leases = new Map<string, LeaseState>();
const leaseLoads = new Map<string, Promise<LeaseState>>();
const port = Number(process.env.FORGER_CONTROL_PLANE_PORT ?? 8790);
const token = process.env.FORGER_CONTROL_PLANE_TOKEN?.trim() ?? '';
const auditRoot = resolve(process.env.FORGER_CONTROL_AUDIT_ROOT ?? '.forger-control-plane/audit');
const leaseRoot = resolve(process.env.FORGER_CONTROL_LEASE_ROOT ?? '.forger-control-plane/leases');
const maxBodyBytes = Number(process.env.FORGER_CONTROL_MAX_BODY_BYTES ?? 64 * 1024);

function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  if (!token) return true;
  return req.headers.authorization === `Bearer ${token}`;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > maxBodyBytes) throw new Error('BODY_TOO_LARGE');
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('INVALID_JSON_OBJECT');
  return parsed as Record<string, unknown>;
}

function rateLimit(body: Record<string, unknown>): { allowed: boolean; remaining: number; resetAt: number } {
  const scope = String(body.scope ?? '');
  const limit = Number(body.limit);
  const windowMs = Number(body.windowMs);
  const now = Number(body.now ?? Date.now());
  if (!scope || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isFinite(now)) {
    throw new Error('INVALID_RATE_LIMIT_REQUEST');
  }

  const current = windows.get(scope);
  const entry = !current || now - current.windowStart >= windowMs ? { windowStart: now, count: 0 } : current;
  entry.count += 1;
  windows.set(scope, entry);
  return {
    allowed: entry.count <= limit,
    remaining: Math.max(0, limit - entry.count),
    resetAt: entry.windowStart + windowMs
  };
}

function leaseKey(scope: string): string {
  return createHash('sha256').update(scope, 'utf8').digest('hex');
}

function leasePath(scope: string): string {
  return resolve(leaseRoot, `${leaseKey(scope)}.json`);
}

async function loadLease(scope: string): Promise<LeaseState> {
  const key = leaseKey(scope);
  const cached = leases.get(key);
  if (cached) return cached;
  const existingLoad = leaseLoads.get(key);
  if (existingLoad) return existingLoad;

  const loading = (async () => {
    try {
      const parsed = JSON.parse(await readFile(leasePath(scope), 'utf8')) as LeaseState;
      if (!Number.isSafeInteger(parsed.highestFencingToken) || parsed.highestFencingToken < 0) throw new Error('INVALID_PERSISTED_LEASE');
      leases.set(key, parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const fresh: LeaseState = { highestFencingToken: 0 };
      leases.set(key, fresh);
      return fresh;
    } finally {
      leaseLoads.delete(key);
    }
  })();
  leaseLoads.set(key, loading);
  return loading;
}

async function persistLease(scope: string, state: LeaseState): Promise<void> {
  const path = leasePath(scope);
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

function parseLeaseRequest(body: Record<string, unknown>, requireToken: boolean): {
  scope: string;
  holder: string;
  fencingToken?: number;
  ttlMs?: number;
  now: number;
} {
  const scope = String(body.scope ?? '');
  const holder = String(body.holder ?? '');
  const fencingToken = body.fencingToken === undefined ? undefined : Number(body.fencingToken);
  const ttlMs = body.ttlMs === undefined ? undefined : Number(body.ttlMs);
  const now = Number(body.now ?? Date.now());
  if (!scope || !holder || !Number.isFinite(now)) throw new Error('INVALID_LEASE_REQUEST');
  if (requireToken && (!Number.isSafeInteger(fencingToken) || Number(fencingToken) < 1)) throw new Error('INVALID_LEASE_REQUEST');
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 1)) throw new Error('INVALID_LEASE_REQUEST');
  return { scope, holder, fencingToken, ttlMs, now };
}

async function acquireLease(body: Record<string, unknown>) {
  const request = parseLeaseRequest(body, false);
  if (!request.ttlMs) throw new Error('INVALID_LEASE_REQUEST');
  const state = await loadLease(request.scope);
  const active = Boolean(state.holder && state.fencingToken && state.expiresAt && state.expiresAt > request.now);
  if (active) return { acquired: false, fencingToken: state.fencingToken!, expiresAt: state.expiresAt! };

  const fencingToken = state.highestFencingToken + 1;
  state.highestFencingToken = fencingToken;
  state.holder = request.holder;
  state.fencingToken = fencingToken;
  state.expiresAt = request.now + request.ttlMs;
  await persistLease(request.scope, state);
  return { acquired: true, fencingToken, expiresAt: state.expiresAt };
}

async function renewLease(body: Record<string, unknown>) {
  const request = parseLeaseRequest(body, true);
  if (!request.ttlMs) throw new Error('INVALID_LEASE_REQUEST');
  const state = await loadLease(request.scope);
  const valid = state.holder === request.holder && state.fencingToken === request.fencingToken && Boolean(state.expiresAt && state.expiresAt > request.now);
  if (!valid) return { acquired: false, fencingToken: state.highestFencingToken, expiresAt: state.expiresAt ?? 0 };
  state.expiresAt = request.now + request.ttlMs;
  await persistLease(request.scope, state);
  return { acquired: true, fencingToken: request.fencingToken!, expiresAt: state.expiresAt };
}

async function validateLease(body: Record<string, unknown>) {
  const request = parseLeaseRequest(body, true);
  const state = await loadLease(request.scope);
  const valid = state.holder === request.holder && state.fencingToken === request.fencingToken && Boolean(state.expiresAt && state.expiresAt > request.now);
  return { valid, fencingToken: state.highestFencingToken, expiresAt: state.expiresAt ?? 0 };
}

async function releaseLease(body: Record<string, unknown>) {
  const request = parseLeaseRequest(body, true);
  const state = await loadLease(request.scope);
  const released = state.holder === request.holder && state.fencingToken === request.fencingToken;
  if (released) {
    delete state.holder;
    delete state.fencingToken;
    delete state.expiresAt;
    await persistLease(request.scope, state);
  }
  return { released, fencingToken: state.highestFencingToken };
}

async function appendAudit(record: Record<string, unknown>): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  const path = resolve(auditRoot, `${date}.ndjson`);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function createControlPlaneServer() {
  return createServer(async (req, res) => {
    try {
      if (req.url === '/health' && req.method === 'GET') {
        json(res, 200, { ok: true, service: 'semantic-as-code-forger-control-plane', leases: 'durable-fencing-v1' });
        return;
      }
      if (!authorized(req)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (req.url === '/v1/rate-limit/consume' && req.method === 'POST') {
        json(res, 200, rateLimit(await readJson(req)));
        return;
      }
      if (req.url === '/v1/audit' && req.method === 'POST') {
        const record = await readJson(req);
        await appendAudit(record);
        json(res, 202, { accepted: true });
        return;
      }
      if (req.url === '/v1/lease/acquire' && req.method === 'POST') {
        json(res, 200, await acquireLease(await readJson(req)));
        return;
      }
      if (req.url === '/v1/lease/renew' && req.method === 'POST') {
        json(res, 200, await renewLease(await readJson(req)));
        return;
      }
      if (req.url === '/v1/lease/validate' && req.method === 'POST') {
        json(res, 200, await validateLease(await readJson(req)));
        return;
      }
      if (req.url === '/v1/lease/release' && req.method === 'POST') {
        json(res, 200, await releaseLease(await readJson(req)));
        return;
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (message === 'BODY_TOO_LARGE') json(res, 413, { error: message });
      else if (message.startsWith('INVALID_') || error instanceof SyntaxError) json(res, 400, { error: message });
      else {
        console.error('[control-plane]', error);
        json(res, 500, { error: 'Internal error' });
      }
    }
  });
}

if (process.env.NODE_ENV !== 'test') {
  const server = createControlPlaneServer();
  server.listen(port, () => console.log(`[forger-control-plane] http://localhost:${port}`));
}
