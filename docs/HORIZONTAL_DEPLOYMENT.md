# Horizontal deployment

Semantic-as-Code Forger v0.7 supports multiple application instances without making the semantic engine depend on a particular infrastructure vendor.

## Topology

```text
                    ┌──────────────────────────┐
                    │  Load balancer / proxy   │
                    └────────────┬─────────────┘
                                 │
               ┌─────────────────┼─────────────────┐
               │                 │                 │
       ┌───────▼───────┐ ┌──────▼────────┐ ┌──────▼────────┐
       │ Forger app #1 │ │ Forger app #2 │ │ Forger app #N │
       └───────┬───────┘ └──────┬────────┘ └──────┬────────┘
               │                 │                 │
               └──────────┬──────┴───────┬─────────┘
                          │              │
                ┌─────────▼──────┐  ┌────▼─────────────────┐
                │ shared POSIX   │  │ Forger control-plane │
                │ workspace      │  │ rate limit + audit   │
                └────────────────┘  └──────────────────────┘
```

The application nodes stay stateless with respect to operational policy. Project workspaces remain path-oriented because Blueprint generation, ZIP export and repository review operate on a filesystem tree. For multi-node deployment, `FORGER_WORKSPACE_ROOT` must therefore point to a filesystem mounted consistently on every application node.

The reference control plane is deliberately small. It exposes only two application-facing contracts:

- `POST /v1/rate-limit/consume`
- `POST /v1/audit`

A deployment may replace this service with Redis, NATS, Postgres, a managed gateway, or another implementation as long as it preserves those contracts.

## Single-node defaults

```env
FORGER_INSTANCE_COUNT=1
FORGER_WORKSPACE_BACKEND=local-fs
FORGER_RATE_LIMIT_BACKEND=memory
FORGER_AUDIT_BACKEND=file
```

This is backward-compatible with v0.6.

## Multi-instance configuration

Application instances:

```env
FORGER_INSTANCE_COUNT=3
FORGER_WORKSPACE_BACKEND=shared-posix
FORGER_WORKSPACE_ROOT=/srv/forger/workspaces
FORGER_RATE_LIMIT_BACKEND=http
FORGER_AUDIT_BACKEND=http
FORGER_CONTROL_PLANE_URL=http://forger-control-plane.internal:8790
FORGER_CONTROL_PLANE_TOKEN=<secret>
```

Reference control-plane process:

```env
FORGER_CONTROL_PLANE_PORT=8790
FORGER_CONTROL_PLANE_TOKEN=<same-secret>
FORGER_CONTROL_AUDIT_ROOT=/srv/forger/audit
```

Start it with:

```bash
npm run control-plane
```

The application refuses to start with `FORGER_INSTANCE_COUNT>1` unless the workspace is declared `shared-posix` and both operational policy backends are centralized over HTTP. This prevents silent split-brain rate limits and node-local audit trails.

## Security properties

The control-plane bearer secret is server-side configuration and is never written into generated projects, Forge state or audit records. Rate-limit requests use only an opaque SHA-256-derived tenant scope; raw tenant identifiers do not leave the application instance for policy accounting. Audit records contain hashed tenant/subject identities and exclude credentials and request bodies.

The rate-limit dependency is fail-closed. If the configured centralized service cannot make a decision, the application returns `503` rather than silently bypassing the policy.

## Shared workspace requirements

`shared-posix` means that every application process sees the same bytes for the same absolute `FORGER_WORKSPACE_ROOT`. Suitable implementations include NFS, CephFS, EFS-like mounts, clustered filesystems or a shared host volume for multi-process deployment.

The v0.7 topology solves visibility, not concurrent-write serialization. If two instances mutate the same session at exactly the same time, a future fencing/lease layer must decide which writer owns that mutation. Until that layer is implemented, route a given session consistently to one active writer or otherwise prevent concurrent mutation of the same session.

## Health inspection

`GET /api/health` reports non-secret topology metadata:

```json
{
  "ok": true,
  "service": "semantic-as-code-forger",
  "version": "0.7.0",
  "topology": {
    "instances": 3,
    "workspace": "shared-posix",
    "rateLimit": "http",
    "audit": "http"
  }
}
```

This allows deployment checks to confirm that a horizontally configured process actually started with distributed policy backends.

## Failure boundaries

- Shared workspace unavailable: session/project operations fail rather than switching to a private local copy.
- Control-plane rate limiter unavailable: request is rejected with `503`.
- Audit control plane unavailable after a response: the failure is logged by the app; the user operation is not rolled back because audit delivery is an operational side effect, not semantic state.
- Control-plane restart: the reference in-memory rate window resets. Use a durable/distributed replacement when rate-window continuity across control-plane restarts is required.
- Multiple control-plane replicas: the reference implementation must not be replicated independently because each replica owns its own in-memory rate window. Put one reference control plane behind the app nodes, or replace it with a distributed implementation.

## Production boundary

v0.7 makes the Forger application horizontally deployable behind a shared POSIX workspace and one centralized reference policy service. It intentionally does not claim that the reference control plane itself is horizontally scalable. That service is an interchangeable contract boundary, not a new distributed database.
