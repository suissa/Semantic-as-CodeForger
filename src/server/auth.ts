import type express from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface AuthPrincipal {
  subject: string;
  tenantId: string;
  issuer: string;
}

type AuthMode = 'disabled' | 'oidc';

interface OidcDiscovery {
  issuer?: string;
  jwks_uri?: string;
}

let remoteKeySet: ReturnType<typeof createRemoteJWKSet> | undefined;
let remoteKeySetUri: string | undefined;

function authMode(): AuthMode {
  const mode = (process.env.FORGER_AUTH_MODE ?? 'disabled').trim();
  if (mode === 'disabled' || mode === 'oidc') return mode;
  throw new Error(`Unsupported FORGER_AUTH_MODE: ${mode}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required when FORGER_AUTH_MODE=oidc`);
  return value;
}

function tokenHeaderName(): string {
  return (process.env.FORGER_AUTH_TOKEN_HEADER ?? 'authorization').trim().toLowerCase();
}

export function extractAccessToken(headers: Record<string, string | string[] | undefined>): string | undefined {
  const name = tokenHeaderName();
  const rawValue = headers[name];
  const raw = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  if (!raw) return undefined;
  if (name === 'authorization') {
    const match = raw.match(/^Bearer\s+(.+)$/i);
    return match?.[1]?.trim();
  }
  return raw.trim() || undefined;
}

export function principalFromClaims(payload: JWTPayload, issuer: string): AuthPrincipal {
  const subject = typeof payload.sub === 'string' ? payload.sub.trim() : '';
  if (!subject) throw new Error('OIDC token has no subject');

  const tenantClaim = (process.env.FORGER_OIDC_TENANT_CLAIM ?? 'sub').trim();
  const tenantValue = payload[tenantClaim];
  const tenantId = typeof tenantValue === 'string' ? tenantValue.trim() : '';
  if (!tenantId) throw new Error(`OIDC token has no usable tenant claim: ${tenantClaim}`);

  return { subject, tenantId, issuer };
}

async function resolveJwksUri(issuer: string): Promise<string> {
  const configured = process.env.FORGER_OIDC_JWKS_URI?.trim();
  if (configured) return configured;

  const discoveryUrl = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const response = await fetch(discoveryUrl, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`OIDC discovery failed (${response.status})`);
  const document = await response.json() as OidcDiscovery;
  if (document.issuer && document.issuer !== issuer) throw new Error('OIDC discovery issuer mismatch');
  if (!document.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
  return document.jwks_uri;
}

async function keySet(issuer: string): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const uri = await resolveJwksUri(issuer);
  if (!remoteKeySet || remoteKeySetUri !== uri) {
    remoteKeySet = createRemoteJWKSet(new URL(uri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000
    });
    remoteKeySetUri = uri;
  }
  return remoteKeySet;
}

async function authenticateOidc(headers: Record<string, string | string[] | undefined>): Promise<AuthPrincipal> {
  const token = extractAccessToken(headers);
  if (!token) throw new Error('Missing OIDC bearer token');

  const issuer = requiredEnv('FORGER_OIDC_ISSUER');
  const audienceValues = requiredEnv('FORGER_OIDC_AUDIENCE').split(',').map((value) => value.trim()).filter(Boolean);
  const audience: string | string[] = audienceValues.length === 1 ? audienceValues[0]! : audienceValues;
  const algorithms = (process.env.FORGER_OIDC_ALGORITHMS ?? 'RS256,ES256,EdDSA').split(',').map((value) => value.trim()).filter(Boolean);
  const keys = await keySet(issuer);
  const verified = await jwtVerify(token, keys, { issuer, audience, algorithms });
  return principalFromClaims(verified.payload, issuer);
}

export async function authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthPrincipal> {
  if (authMode() === 'disabled') return { subject: 'local', tenantId: 'local', issuer: 'local' };
  return authenticateOidc(headers);
}

export async function authenticationMiddleware(req: express.Request, res: express.Response, next: express.NextFunction): Promise<void> {
  try {
    res.locals.principal = await authenticate(req.headers as Record<string, string | string[] | undefined>);
    next();
  } catch (error) {
    res.status(401).json({ error: error instanceof Error ? error.message : 'Authentication failed' });
  }
}

export function principalFromResponse(res: express.Response): AuthPrincipal {
  const principal = res.locals.principal as AuthPrincipal | undefined;
  if (!principal) throw new Error('Authenticated principal is unavailable');
  return principal;
}
