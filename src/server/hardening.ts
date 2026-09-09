import { createHash, randomUUID } from 'node:crypto';
import type express from 'express';
import type { AuthPrincipal } from './auth.js';
import { auditBackend, rateLimitBackend, resetRuntimeServiceStateForTests } from '../infra/runtime-services.js';

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function opaqueHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}

function principal(res: express.Response): AuthPrincipal | undefined {
  return res.locals.principal as AuthPrincipal | undefined;
}

export function requestContextMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const supplied = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'].trim() : '';
  const requestId = /^[A-Za-z0-9._:-]{8,128}$/.test(supplied) ? supplied : randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
}

export function securityHeadersMiddleware(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('cross-origin-opener-policy', 'same-origin');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
}

export function tenantRateLimitMiddleware(_req: express.Request, res: express.Response, next: express.NextFunction): void {
  const limit = positiveInteger('FORGER_RATE_LIMIT_PER_MINUTE', 120);
  if (limit === 0) { next(); return; }

  const identity = principal(res);
  if (!identity) { next(); return; }
  const scope = `tenant:${identity.tenantId}`;
  const backend = rateLimitBackend();

  void backend.consume(scope, limit, 60_000).then((decision) => {
    res.setHeader('x-ratelimit-limit', String(limit));
    res.setHeader('x-ratelimit-remaining', String(decision.remaining));
    res.setHeader('x-ratelimit-reset', String(Math.ceil(decision.resetAt / 1000)));
    if (!decision.allowed) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((decision.resetAt - Date.now()) / 1000))));
      res.status(429).json({ error: 'Tenant request rate limit exceeded', requestId: res.locals.requestId });
      return;
    }
    next();
  }).catch((error) => {
    console.error('[rate-limit]', error);
    res.status(503).json({ error: 'Rate-limit service unavailable', requestId: res.locals.requestId });
  });
}

export function auditMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const started = Date.now();
  res.once('finish', () => {
    if ((process.env.FORGER_AUDIT_ENABLED ?? 'true') !== 'true') return;
    const identity = principal(res);
    const record = {
      at: new Date().toISOString(),
      request_id: res.locals.requestId,
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - started,
      tenant_hash: identity ? opaqueHash(identity.tenantId) : null,
      subject_hash: identity ? opaqueHash(`${identity.issuer}\0${identity.subject}`) : null
    };
    void auditBackend().append(record).catch((error) => console.error('[audit]', error));
  });
  next();
}

export function configureServerTimeouts(server: import('node:http').Server): void {
  server.requestTimeout = positiveInteger('FORGER_REQUEST_TIMEOUT_MS', 120_000);
  server.headersTimeout = positiveInteger('FORGER_HEADERS_TIMEOUT_MS', 15_000);
  server.keepAliveTimeout = positiveInteger('FORGER_KEEP_ALIVE_TIMEOUT_MS', 5_000);
  server.maxRequestsPerSocket = positiveInteger('FORGER_MAX_REQUESTS_PER_SOCKET', 1_000);
}

export function resetRateLimitStateForTests(): void {
  resetRuntimeServiceStateForTests();
}
