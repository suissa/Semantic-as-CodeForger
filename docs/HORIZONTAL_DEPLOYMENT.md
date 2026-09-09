# Horizontal deployment

Semantic-as-Code Forger v0.8 supports multiple application instances without making the semantic engine depend on a particular infrastructure vendor.

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
       │ MCP worker    │ │ MCP worker    │ │ MCP worker    │
       └───────┬───────┘ └──────┬────────┘ └──────┬────────┘
               │                 │                 │
               └──────────┬──────┴───────┬─────────┘
                          │              │
                ┌─────────▼──────┐  ┌────▼─────────────────────┐
                │ shared POSIX   │  │ Forger control-plane     │
                │ workspace      │  │ rate + audit + fencing   │
                └────────────────┘  └──────────────────────────┘
```

The application nodes stay stateless with respect to operational policy. Project workspaces remain path-oriented because Blueprint generation, ZIP export and repository review operate on a filesystem tree. For multi-node deployment, `FORGER_WORKSPACE_ROOT` must therefore point to a filesystem mounted consistently on every application node.

The reference control plane exposes these application-facing contracts:

- `POST /v1/rate-limit/consume`
- `POST /v1/audit`
- `POST /v1/lease/acquire`
- `POST /v1/lease/renew`
- `POST /v1/lease/validate`
- `POST /v1/lease/release`

A deployment may replace this service with Redis, NATS, Postgres, a managed coordinator, or another implementation as long as it preserves those contracts and the fencing invariants.

## Single-node defaults

```env
FORGER_INSTANCE_COUNT=1
FORGER_WORKSPACE_BACKEND=local-fs
FORGER_RATE_LIMIT_BACKEND=memory
FORGER_AUDIT_BACKEND=file
FORGER_SESSION_LEASE_BACKEND=memory
FORGER_SESSION_LEASE_TTL_MS=30000
```

This remains convenient for local development. The in-process lease backend still serializes concurrent mutation attempts for the same tenant/session.

## Multi-instance configuration

Application instances:

```env
FORGER_INSTANCE_COUNT=3
FORGER_WORKSPACE_BACKEND=shared-posix
FORGER_WORKSPACE_ROOT=/srv/forger/workspaces
FORGER_RATE_LIMIT_BACKEND=http
FORGER_AUDIT_BACKEND=http
FORGER_SESSION_LEASE_BACKEND=http
FORGER_SESSION_LEASE_TTL_MS=30000
FORGER_CONTROL_PLANE_URL=http://forger-control-plane.internal:8790
FORGER_CONTROL_PLANE_TOKEN=<secret>
```

Reference control-plane process:

```env
FORGER_CONTROL_PLANE_PORT=8790
FORGER_CONTROL_PLANE_TOKEN=<same-secret>
FORGER_CONTROL_AUDIT_ROOT=/srv/forger/audit
FORGER_CONTROL_LEASE_ROOT=/srv/forger/leases
```

Start it with:

```bash
npm run control-plane
```

The application and MCP process refuse to start with `FORGER_INSTANCE_COUNT>1` unless workspace, rate-limit, audit and session-lease topology are explicitly safe for multiple instances. This prevents silent split brain.

## Session lease and fencing semantics

Every mutating MCP tool is executed under a lease scoped to the opaque hash of `(tenant, sessionId)`. Read-only snapshots do not need the lease.

The lifecycle is:

1. A unique operation holder requests the session lease.
2. If another unexpired holder owns it, the mutation is rejected as `409 Conflict`.
3. A successful acquisition receives a monotonically increasing fencing token.
4. Long operations renew their lease periodically.
5. Durable state/event checkpoints validate that the holder still owns exactly that fencing token.
6. When a lease expires, a different holder may take over and receives a strictly larger fencing token.
7. The old holder can no longer renew, validate or release the new holder's lease.

The control plane persists `highestFencingToken` per opaque session scope under `FORGER_CONTROL_LEASE_ROOT`. Therefore a control-plane restart does not reset fencing numbers. An expired holder after restart is replaced by a token greater than every token issued before restart.

The Event Sourcing log and Forge snapshot are fenced before authoritative writes. High-level materializers are followed by a fencing checkpoint before their result can become authoritative state. A holder that loses authority aborts rather than appending a stale semantic event.

## Security properties

The control-plane bearer secret is server-side configuration and is never written into generated projects, Forge state or audit records. Rate-limit and lease scopes are opaque SHA-256-derived values; raw tenant identifiers do not leave the application/MCP boundary for coordination. Audit records contain hashed tenant/subject identities and exclude credentials and request bodies.

The rate-limit dependency is fail-closed. Session mutation coordination is also fail-closed: if the configured lease service cannot acquire/renew/validate authority, the mutation is not silently permitted.

## Shared workspace requirements

`shared-posix` means that every application process sees the same bytes for the same absolute `FORGER_WORKSPACE_ROOT`. Suitable implementations include NFS, CephFS, EFS-like mounts, clustered filesystems or a shared host volume for multi-process deployment.

Sticky routing is no longer a correctness requirement for session mutations in v0.8. It can still be used for cache locality or latency, but ownership is decided by the lease/fencing protocol rather than by the load balancer.

## Health inspection

`GET /api/health` reports non-secret topology metadata:

```json
{
  "ok": true,
  "service": "semantic-as-code-forger",
  "version": "0.8.0",
  "topology": {
    "instances": 3,
    "workspace": "shared-posix",
    "rateLimit": "http",
    "audit": "http",
    "sessionLease": "http"
  }
}
```

## Failure boundaries

- Shared workspace unavailable: session/project operations fail rather than switching to a private local copy.
- Control-plane rate limiter unavailable: request is rejected with `503`.
- Lease acquisition unavailable: mutation fails closed; no local fallback is used in a horizontally configured process.
- Lease renewal/validation lost: the operation loses authority and cannot commit subsequent fenced state/event writes.
- Audit control plane unavailable after a response: the failure is logged by the app; the user operation is not rolled back because audit delivery is an operational side effect, not semantic state.
- Control-plane restart: rate windows still reset in the reference implementation, but fencing tokens do not; lease epochs are durable.
- Multiple independent reference control-plane replicas: not supported. The reference coordinator is intentionally a singleton. Replace it with a distributed implementation if the coordinator itself must be horizontally available.

## Production boundary

v0.8 makes the Forger application horizontally deployable with shared workspace visibility and explicit single-writer authority per tenant/session. The reference control plane remains an interchangeable singleton coordination boundary rather than a distributed database. A production deployment that needs coordinator high availability should implement the same contracts over a linearizable/durable backend while preserving monotonic fencing tokens.
