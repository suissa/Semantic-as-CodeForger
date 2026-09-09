# Hosted Security and Isolation

Semantic-as-Code Forger v0.6 supports a governed single-node hosted deployment while preserving the local development mode.

## Authentication modes

`FORGER_AUTH_MODE=disabled` preserves the original local single-user behavior. The effective principal and tenant are both `local`, and sessions continue to live directly under `.forger-workspaces/<session>`.

`FORGER_AUTH_MODE=oidc` requires a signed bearer JWT. The server verifies:

- signature against a remote JWKS;
- exact issuer;
- configured audience;
- an explicit allow-list of signature algorithms;
- the configured tenant claim only after cryptographic verification.

The secure default tenant claim is `sub`, which isolates one workspace namespace per authenticated subject. A hosted organization product may instead configure an already verified organization/workspace claim such as `org_id`.

The Forger does not trust a tenant identifier supplied in request JSON. HTTP derives the tenant from the verified principal and injects it into every MCP call. The MCP server independently requires `tenantId` on every tool invocation.

A first-party browser login flow is intentionally not bundled yet. A hosted deployment can use a trusted same-origin identity proxy that authenticates the user and injects the bearer JWT. If direct browser OIDC is later required, it should be implemented as a separate login/session surface rather than weakening API token validation.

## Filesystem isolation

Raw tenant values never become filesystem path components. For hosted tenants the namespace is:

```text
.forger-workspaces/
└── tenants/
    └── tenant-<first-32-hex-of-sha256(tenant-id)>/
        └── <session-id>/
            ├── forge-state.json
            ├── interview-events.ndjson
            └── project/
```

The `local` tenant keeps the legacy layout for backward compatibility.

Tenant context is propagated inside the MCP process with `AsyncLocalStorage`. Concurrent calls therefore keep independent tenant namespaces even though they share the same process.

## Secret isolation

Authentication tokens are consumed only by the HTTP authentication layer. Only the derived opaque tenant identity reaches MCP. The raw bearer token, OIDC claims, GitHub token and LLM API key are not written to project state, generated Blueprint files or audit records.

GitHub and LLM credentials remain process environment secrets. Repository delivery state contains repository/branch/review metadata but not credentials.

## Operational audit

Every HTTP request receives an `x-request-id`. When `FORGER_AUDIT_ENABLED=true`, the server appends an NDJSON operational record under:

```text
.forger-workspaces/_audit/YYYY-MM-DD.ndjson
```

Records contain request id, method, path, status, duration, and SHA-256-derived hashes for tenant/subject identity. Request bodies, bearer tokens, raw tenant identifiers and raw subject identifiers are not logged.

This is an operational audit trail, not a formal proof artifact and not the semantic interview Event Store.

## Rate limiting and quotas

The HTTP layer applies a per-tenant fixed-window request limit. `429` responses include reset/retry metadata.

The MCP mutation boundary separately enforces session quotas so a direct MCP client cannot bypass HTTP limits:

- maximum artifact identities per session;
- maximum interview turns;
- maximum serialized bytes per artifact;
- maximum message characters;
- maximum facts per turn;
- maximum characters per fact.

Refining an existing `(kind, canonicalLabel)` remains allowed when the artifact-count quota is reached because this does not create a new semantic identity.

## Request hardening

Hosted responses include restrictive security headers, including CSP, frame denial, MIME sniffing denial, referrer restrictions and browser permission restrictions. Express's identifying `x-powered-by` header is disabled.

JSON input size and Node HTTP request/header/keep-alive timeouts are configurable. Message size is independently bounded before LLM analysis.

## Workspace retention

`FORGER_RETENTION_DAYS` controls inactivity retention using the session state's `updatedAt` value, falling back to directory mtime only when state is unavailable.

The retention command is deliberately non-destructive by default:

```bash
npm run workspace:gc
```

It reports expired local and hosted-tenant sessions. Actual deletion requires:

```bash
npm run workspace:gc:apply
```

The deletion implementation refuses paths outside `FORGER_WORKSPACE_ROOT`.

## Canonical AllasCode runtime contract

`runtime.lock.json` pins the canonical independent-model contract from `suissa/AllasCode` by commit and Git blob SHA. Vendored copies include the JSON Schema and official valid/invalid vectors.

CI always recomputes every local Git blob SHA. Remote byte-for-byte verification is optional because the upstream repository may require credentials that the Forger CI should not automatically broaden:

```bash
FORGER_RUNTIME_VERIFY_REMOTE=true npm run runtime:verify
```

Every generated project receives:

```text
allascode.model.json
.allascode/runtime.lock.json
docs/RUNTIME_CONFORMANCE.md
```

The generated descriptor is validated against the pinned Draft 2020-12 schema during project initialization and again before finalization.

## Deployment boundary

v0.6 filesystem isolation, audit files and rate limiting are intentionally process/node local. A single persistent server/node is therefore the supported hosted topology for this version.

Before horizontal multi-instance deployment, replace:

- local workspace filesystem with durable shared/object storage or a tenant-safe storage service;
- process-local rate limiting with a distributed limiter;
- local audit files with a durable audit sink/rotation policy.

Do not place multiple stateless replicas in front of the same user traffic while retaining the current local workspace model; that would make session routing and limits inconsistent even though tenant path derivation itself is deterministic.
