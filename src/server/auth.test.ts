import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticate, extractAccessToken, principalFromClaims } from './auth.js';

test('disabled auth produces the backward-compatible local principal', async () => {
  const previous = process.env.FORGER_AUTH_MODE;
  process.env.FORGER_AUTH_MODE = 'disabled';
  try {
    assert.deepEqual(await authenticate({}), { subject: 'local', tenantId: 'local', issuer: 'local' });
  } finally {
    if (previous === undefined) delete process.env.FORGER_AUTH_MODE;
    else process.env.FORGER_AUTH_MODE = previous;
  }
});

test('extracts bearer token only from a valid Authorization scheme', () => {
  const previous = process.env.FORGER_AUTH_TOKEN_HEADER;
  delete process.env.FORGER_AUTH_TOKEN_HEADER;
  try {
    assert.equal(extractAccessToken({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
    assert.equal(extractAccessToken({ authorization: 'Basic abc' }), undefined);
  } finally {
    if (previous !== undefined) process.env.FORGER_AUTH_TOKEN_HEADER = previous;
  }
});

test('supports a verified custom token header for auth proxies', () => {
  const previous = process.env.FORGER_AUTH_TOKEN_HEADER;
  process.env.FORGER_AUTH_TOKEN_HEADER = 'x-forger-access-token';
  try {
    assert.equal(extractAccessToken({ 'x-forger-access-token': 'signed.jwt.value' }), 'signed.jwt.value');
  } finally {
    if (previous === undefined) delete process.env.FORGER_AUTH_TOKEN_HEADER;
    else process.env.FORGER_AUTH_TOKEN_HEADER = previous;
  }
});

test('tenant claim defaults to subject and can be configured to an organization claim', () => {
  const previous = process.env.FORGER_OIDC_TENANT_CLAIM;
  try {
    delete process.env.FORGER_OIDC_TENANT_CLAIM;
    assert.deepEqual(principalFromClaims({ sub: 'user-1' }, 'https://issuer.example'), {
      subject: 'user-1', tenantId: 'user-1', issuer: 'https://issuer.example'
    });

    process.env.FORGER_OIDC_TENANT_CLAIM = 'org_id';
    assert.deepEqual(principalFromClaims({ sub: 'user-1', org_id: 'org-9' }, 'https://issuer.example'), {
      subject: 'user-1', tenantId: 'org-9', issuer: 'https://issuer.example'
    });
    assert.throws(() => principalFromClaims({ sub: 'user-1' }, 'https://issuer.example'), /tenant claim/);
  } finally {
    if (previous === undefined) delete process.env.FORGER_OIDC_TENANT_CLAIM;
    else process.env.FORGER_OIDC_TENANT_CLAIM = previous;
  }
});
