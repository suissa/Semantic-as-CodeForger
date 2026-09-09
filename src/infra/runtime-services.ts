import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitBackend {
  readonly kind: string;
  consume(scope: string, limit: number, windowMs: number, now?: number): Promise<RateLimitDecision>;
}

export interface AuditBackend {
  readonly kind: string;
  append(record: Record<string, unknown>): Promise<void>;
}

export interface WorkspaceBackend {
  readonly kind: 'local-fs' | 'shared-posix';
  readonly supportsMultiInstance: boolean;
  root(): string;
}

export interface LeaseDecision {
  acquired: boolean;
  fencingToken: number;
  expiresAt: number;
}

export interface LeaseValidation {
  valid: boolean;
  fencingToken: number;
  expiresAt: number;
}

export interface LeaseRelease {
  released: boolean;
  fencingToken: number;
}

export interface SessionLeaseBackend {
  readonly kind: string;
  acquire(scope: string, holder: string, ttlMs: number, now?: number): Promise<LeaseDecision>;
  renew(scope: string, holder: string, fencingToken: number, ttlMs: number, now?: number): Promise<LeaseDecision>;
  validate(scope: string, holder: string, fencingToken: number, now?: number): Promise<LeaseValidation>;
  release(scope: string, holder: string, fencingToken: number): Promise<LeaseRelease>;
}

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

const memoryWindows = new Map<string, WindowEntry>();
const memoryLeases = new Map<string, LeaseState>();

function env(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function opaqueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

export class MemoryRateLimitBackend implements RateLimitBackend {
  readonly kind = 'memory';

  async consume(scope: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitDecision> {
    const key = opaqueHash(scope);
    const current = memoryWindows.get(key);
    const entry = !current || now - current.windowStart >= windowMs ? { windowStart: now, count: 0 } : current;
    entry.count += 1;
    memoryWindows.set(key, entry);
    const resetAt = entry.windowStart + windowMs;
    return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt };
  }
}

export class MemorySessionLeaseBackend implements SessionLeaseBackend {
  readonly kind = 'memory';

  async acquire(scope: string, holder: string, ttlMs: number, now = Date.now()): Promise<LeaseDecision> {
    assertPositiveInteger(ttlMs, 'lease ttl');
    const key = opaqueHash(scope);
    const current = memoryLeases.get(key) ?? { highestFencingToken: 0 };
    const active = current.holder && current.fencingToken && current.expiresAt && current.expiresAt > now;
    if (active) {
      return { acquired: false, fencingToken: current.fencingToken!, expiresAt: current.expiresAt! };
    }

    const fencingToken = current.highestFencingToken + 1;
    const next: LeaseState = {
      highestFencingToken: fencingToken,
      holder,
      fencingToken,
      expiresAt: now + ttlMs
    };
    memoryLeases.set(key, next);
    return { acquired: true, fencingToken, expiresAt: next.expiresAt! };
  }

  async renew(scope: string, holder: string, fencingToken: number, ttlMs: number, now = Date.now()): Promise<LeaseDecision> {
    assertPositiveInteger(ttlMs, 'lease ttl');
    const key = opaqueHash(scope);
    const current = memoryLeases.get(key) ?? { highestFencingToken: 0 };
    const valid = current.holder === holder && current.fencingToken === fencingToken && Boolean(current.expiresAt && current.expiresAt > now);
    if (!valid) {
      return { acquired: false, fencingToken: current.highestFencingToken, expiresAt: current.expiresAt ?? 0 };
    }
    current.expiresAt = now + ttlMs;
    memoryLeases.set(key, current);
    return { acquired: true, fencingToken, expiresAt: current.expiresAt };
  }

  async validate(scope: string, holder: string, fencingToken: number, now = Date.now()): Promise<LeaseValidation> {
    const current = memoryLeases.get(opaqueHash(scope)) ?? { highestFencingToken: 0 };
    const valid = current.holder === holder && current.fencingToken === fencingToken && Boolean(current.expiresAt && current.expiresAt > now);
    return { valid, fencingToken: current.highestFencingToken, expiresAt: current.expiresAt ?? 0 };
  }

  async release(scope: string, holder: string, fencingToken: number): Promise<LeaseRelease> {
    const key = opaqueHash(scope);
    const current = memoryLeases.get(key) ?? { highestFencingToken: 0 };
    const released = current.holder === holder && current.fencingToken === fencingToken;
    if (released) {
      memoryLeases.set(key, { highestFencingToken: current.highestFencingToken });
    }
    return { released, fencingToken: current.highestFencingToken };
  }
}

export class FileAuditBackend implements AuditBackend {
  readonly kind = 'file';

  constructor(private readonly workspaceRoot: string) {}

  async append(record: Record<string, unknown>): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const path = resolve(this.workspaceRoot, '_audit', `${date}.ndjson`);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export class HttpControlPlaneBackend implements RateLimitBackend, AuditBackend, SessionLeaseBackend {
  readonly kind = 'http-control-plane';
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: { baseUrl?: string; token?: string; timeoutMs?: number } = {}) {
    this.baseUrl = (options.baseUrl ?? env('FORGER_CONTROL_PLANE_URL')).replace(/\/$/, '');
    this.token = options.token ?? env('FORGER_CONTROL_PLANE_TOKEN');
    this.timeoutMs = options.timeoutMs ?? Number(env('FORGER_CONTROL_PLANE_TIMEOUT_MS', '3000'));
    if (!this.baseUrl) throw new Error('FORGER_CONTROL_PLANE_URL is required for http control-plane backends');
    assertPositiveInteger(this.timeoutMs, 'FORGER_CONTROL_PLANE_TIMEOUT_MS');
  }

  private async request(path: string, body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Control plane ${path} failed with HTTP ${response.status}`);
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async consume(scope: string, limit: number, windowMs: number, now = Date.now()): Promise<RateLimitDecision> {
    const response = await this.request('/v1/rate-limit/consume', { scope, limit, windowMs, now });
    const decision = await response.json() as Partial<RateLimitDecision>;
    if (typeof decision.allowed !== 'boolean' || typeof decision.remaining !== 'number' || typeof decision.resetAt !== 'number') {
      throw new Error('Invalid control-plane rate-limit response');
    }
    return decision as RateLimitDecision;
  }

  async append(record: Record<string, unknown>): Promise<void> {
    await this.request('/v1/audit', record);
  }

  async acquire(scope: string, holder: string, ttlMs: number, now = Date.now()): Promise<LeaseDecision> {
    const response = await this.request('/v1/lease/acquire', { scope, holder, ttlMs, now });
    return this.readLeaseDecision(response);
  }

  async renew(scope: string, holder: string, fencingToken: number, ttlMs: number, now = Date.now()): Promise<LeaseDecision> {
    const response = await this.request('/v1/lease/renew', { scope, holder, fencingToken, ttlMs, now });
    return this.readLeaseDecision(response);
  }

  async validate(scope: string, holder: string, fencingToken: number, now = Date.now()): Promise<LeaseValidation> {
    const response = await this.request('/v1/lease/validate', { scope, holder, fencingToken, now });
    const value = await response.json() as Partial<LeaseValidation>;
    if (typeof value.valid !== 'boolean' || typeof value.fencingToken !== 'number' || typeof value.expiresAt !== 'number') {
      throw new Error('Invalid control-plane lease validation response');
    }
    return value as LeaseValidation;
  }

  async release(scope: string, holder: string, fencingToken: number): Promise<LeaseRelease> {
    const response = await this.request('/v1/lease/release', { scope, holder, fencingToken });
    const value = await response.json() as Partial<LeaseRelease>;
    if (typeof value.released !== 'boolean' || typeof value.fencingToken !== 'number') {
      throw new Error('Invalid control-plane lease release response');
    }
    return value as LeaseRelease;
  }

  private async readLeaseDecision(response: Response): Promise<LeaseDecision> {
    const value = await response.json() as Partial<LeaseDecision>;
    if (typeof value.acquired !== 'boolean' || typeof value.fencingToken !== 'number' || typeof value.expiresAt !== 'number') {
      throw new Error('Invalid control-plane lease decision response');
    }
    return value as LeaseDecision;
  }
}

export function workspaceBackend(): WorkspaceBackend {
  const kind = env('FORGER_WORKSPACE_BACKEND', 'local-fs');
  const root = resolve(env('FORGER_WORKSPACE_ROOT', '.forger-workspaces'));
  if (kind === 'local-fs') return { kind, supportsMultiInstance: false, root: () => root };
  if (kind === 'shared-posix') return { kind, supportsMultiInstance: true, root: () => root };
  throw new Error(`Unsupported FORGER_WORKSPACE_BACKEND: ${kind}`);
}

export function rateLimitBackend(): RateLimitBackend {
  const kind = env('FORGER_RATE_LIMIT_BACKEND', 'memory');
  if (kind === 'memory') return new MemoryRateLimitBackend();
  if (kind === 'http') return new HttpControlPlaneBackend();
  throw new Error(`Unsupported FORGER_RATE_LIMIT_BACKEND: ${kind}`);
}

export function auditBackend(): AuditBackend {
  const kind = env('FORGER_AUDIT_BACKEND', 'file');
  if (kind === 'file') return new FileAuditBackend(workspaceBackend().root());
  if (kind === 'http') return new HttpControlPlaneBackend();
  throw new Error(`Unsupported FORGER_AUDIT_BACKEND: ${kind}`);
}

export function sessionLeaseBackend(): SessionLeaseBackend {
  const kind = env('FORGER_SESSION_LEASE_BACKEND', 'memory');
  if (kind === 'memory') return new MemorySessionLeaseBackend();
  if (kind === 'http') return new HttpControlPlaneBackend();
  throw new Error(`Unsupported FORGER_SESSION_LEASE_BACKEND: ${kind}`);
}

export function assertRuntimeTopology(): void {
  const instances = Number(env('FORGER_INSTANCE_COUNT', '1'));
  if (!Number.isSafeInteger(instances) || instances < 1) throw new Error('FORGER_INSTANCE_COUNT must be a positive integer');

  const workspace = workspaceBackend();
  const rate = env('FORGER_RATE_LIMIT_BACKEND', 'memory');
  const audit = env('FORGER_AUDIT_BACKEND', 'file');
  const lease = env('FORGER_SESSION_LEASE_BACKEND', 'memory');
  if (!['memory', 'http'].includes(rate)) throw new Error(`Unsupported FORGER_RATE_LIMIT_BACKEND: ${rate}`);
  if (!['file', 'http'].includes(audit)) throw new Error(`Unsupported FORGER_AUDIT_BACKEND: ${audit}`);
  if (!['memory', 'http'].includes(lease)) throw new Error(`Unsupported FORGER_SESSION_LEASE_BACKEND: ${lease}`);
  if (rate === 'http' || audit === 'http' || lease === 'http') new HttpControlPlaneBackend();

  if (instances === 1) return;
  const errors: string[] = [];
  if (!workspace.supportsMultiInstance) errors.push('FORGER_WORKSPACE_BACKEND=shared-posix');
  if (rate !== 'http') errors.push('FORGER_RATE_LIMIT_BACKEND=http');
  if (audit !== 'http') errors.push('FORGER_AUDIT_BACKEND=http');
  if (lease !== 'http') errors.push('FORGER_SESSION_LEASE_BACKEND=http');
  if (errors.length) throw new Error(`Multi-instance topology requires ${errors.join(', ')}`);
}

export function resetRuntimeServiceStateForTests(): void {
  memoryWindows.clear();
  memoryLeases.clear();
}
