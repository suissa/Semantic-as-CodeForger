# Semantic-as-Code Forger

A fullstack TypeScript application that turns a conversation about a system into an incrementally materialized **AllasCode Blueprint**.

The web UI behaves like an architecture interview. The backend extracts semantic artifacts and, instead of writing project files directly, acts as an **MCP client**. A dedicated MCP server is the mutation boundary that creates, validates and can publish the finalized project tree.

## Why this shape

```text
User conversation
      ↓
Semantic interviewer / extractor
      ↓ semantic artifacts
Authenticated tenant context
      ↓
Backend MCP client
      ↓ governed tool calls
Blueprint/runtime materializer
      ↓ pinned contracts
AllasCode project tree
      ↓ finalize
Fresh repository review token
      ↓ explicit approval
GitHub review branch
      ↓ optional policy
Pull Request
```

This keeps LLM reasoning probabilistic while mutation, tenancy, source pinning, repository review and formal-proof claims remain deterministic and governed.

## AllasCode rules encoded

- Intent is an immutable desired outcome.
- Reusable `atomic_behavior` is distinct from an Intent-instantiated `domain_action`.
- Domain Actions receive their listened event from the flow.
- Concrete behavior result consequences are always `.Ok` and `.Error`; they are non-configurable.
- Error consequences carry mandatory self-healing and can fall back to Human-in-the-Healing-Loop.
- Semantic identity is modeled before storage/transport concerns.
- `relationship` and `identity_rule` model cross-Entity identity and behavior-completing relationships without flattening them into foreign keys.
- 2flow text is parsed deterministically into an AST before visualization.
- `proof_obligation` and `evidence` are distinct. Tests, logs and runtime events are not formal proofs by themselves.
- Interview state is Event Sourced and can be replayed from the append-only NDJSON stream.
- Repository publication is impossible without a fresh diff review bound to the exact workspace and parent SHA.
- Pull Request creation is separate from branch publication and can be manual or an `after_publish` policy.

## Pinned AllasCode-Blueprint source

Generation is reproducible against `blueprint.lock.json`. The lock pins `suissa/AllasCode-Blueprint` by full commit and Git blob SHA for every structural source used by the renderer.

```bash
npm run blueprint:verify
npm run blueprint:sync
```

Every generated project receives `.allascode/blueprint.lock.json` and `docs/BLUEPRINT_SOURCE.md`. Older upstream prose that uses `success/failure` is treated as legacy documentation; the compatibility overlay keeps current structural `Ok/Error`, mandatory self-healing and immutable Intent semantics authoritative.

## Canonical AllasCode runtime boundary

`runtime.lock.json` pins the canonical independent-model contract from `suissa/AllasCode`, including:

- `schemas/allascode.model.schema.json`;
- the official valid model vector;
- the official invalid `embedded=true` vector.

Every vendored file is bound to its canonical Git blob SHA. CI always recomputes those local hashes:

```bash
npm run runtime:verify
```

If an environment has explicit permission to read the pinned upstream repository, remote byte-for-byte comparison can additionally be enabled:

```bash
FORGER_RUNTIME_VERIFY_REMOTE=true npm run runtime:verify
```

Every forged project receives:

```text
allascode.model.json
.allascode/runtime.lock.json
docs/RUNTIME_CONFORMANCE.md
```

The descriptor is validated against the pinned JSON Schema during initialization and again before finalization.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787`
- MCP: `npm run mcp`

`FORGER_AUTH_MODE=disabled` is the backward-compatible local mode.

For structured extraction, configure any OpenAI-compatible chat-completions provider:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-5
```

Without an API key the interview still runs deterministically and preserves answers/facts, but it does not attempt rich artifact extraction from free-form language.

## Hosted authentication and tenant isolation

Set:

```bash
FORGER_AUTH_MODE=oidc
FORGER_OIDC_ISSUER=https://issuer.example
FORGER_OIDC_AUDIENCE=semantic-as-code-forger
FORGER_OIDC_TENANT_CLAIM=sub
```

OIDC mode validates JWT signature, issuer, audience and allowed algorithms before reading the tenant claim. The default `sub` gives one isolated workspace namespace per authenticated subject; an organization product may use a verified claim such as `org_id`.

Raw tenant identifiers never become filesystem paths. Hosted storage uses opaque SHA-256-derived namespaces:

```text
.forger-workspaces/tenants/tenant-<opaque-hash>/<session>/...
```

Every MCP tool requires `tenantId`; HTTP derives it from the verified principal and injects it rather than trusting request JSON. Local mode retains the legacy `.forger-workspaces/<session>` layout.

The current hosted topology is intentionally **single-node**. Before horizontal replicas, replace local workspace storage and process-local rate limiting with shared durable equivalents.

See [`docs/HOSTED_SECURITY.md`](docs/HOSTED_SECURITY.md) for the complete isolation, audit, quota and deployment model.

## Hosted hardening

v0.6 includes:

- per-tenant HTTP rate limiting;
- MCP-level artifact/turn/message/fact/byte quotas;
- bounded JSON input and interview message sizes;
- request IDs;
- CSP and restrictive browser security headers;
- configurable Node HTTP timeouts;
- append-only operational audit records containing hashed tenant/subject identities only;
- no authentication token/request body logging;
- configurable session retention;
- dry-run workspace GC by default.

```bash
npm run workspace:gc
npm run workspace:gc:apply
```

The second command is the only one that deletes expired session directories.

## GitHub delivery

To review/publish against GitHub, configure a narrowly scoped token:

```bash
FORGER_GITHUB_TOKEN=...
```

Read access is enough for review. Branch publication requires Contents write permission. Pull Request creation additionally requires permission to create pull requests. The token stays server-side and is never written into Forge state or generated project files.

Repository target policy example:

```json
{
  "repository": "owner/repo",
  "baseBranch": "main",
  "targetBranch": "forger/project-session",
  "pathPrefix": "Blueprint",
  "pullRequestPolicy": "manual",
  "pullRequestDraft": false
}
```

`pullRequestPolicy` accepts `manual` or `after_publish`.

## API

- `GET /api/health` — unauthenticated process health.
- `POST /api/sessions` — start a project interview.
- `GET /api/sessions/:id` — replay/read current state, tree and validation.
- `POST /api/sessions/:id/messages` — answer the next interview question.
- `POST /api/sessions/:id/finalize` — freeze summary, trace and exported event stream.
- `GET /api/sessions/:id/export` — download the generated Blueprint as ZIP.
- `POST /api/sessions/:id/repository/target` — configure repository/base/review branch/path and PR policy.
- `POST /api/sessions/:id/repository/review` — compute a non-mutating diff and mint its review token.
- `POST /api/sessions/:id/repository/publish` — publish only the exact reviewed diff.
- `POST /api/sessions/:id/repository/pull-request` — open or reuse a PR for the already-published reviewed branch.

All API routes except health pass through authentication in hosted mode and tenant rate limiting.

## MCP tools

- `forger_session_init`
- `forger_artifact_upsert`
- `forger_session_record_turn`
- `forger_session_snapshot`
- `forger_finalize`
- `forger_repository_target_set`
- `forger_repository_review`
- `forger_repository_publish`
- `forger_repository_pull_request_create`

Every MCP tool requires the opaque authenticated `tenantId`. The MCP server scopes the whole call using `AsyncLocalStorage`, and project/state paths derive from that tenant context.

## Repository review and staleness gate

Publication is intentionally separate from review:

1. Configure a GitHub target.
2. Build a non-mutating review from the remote Git tree and local Git blob hashes.
3. Mint a review token bound to repository, target branch/path, parent SHA and every generated file hash.
4. Publish only when the current workspace and remote parent still match that review.

Publication is rejected when workspace content or the relevant remote branch changed after review, a target appeared after a base review, a stale token is supplied, or the review was already published. Remote files not owned by the generated workspace are preserved rather than implicitly deleted.

## Pull Request delivery

Branch materialization is the authoritative write operation. Pull Requests are optional:

- `manual`: publish the reviewed branch first, then explicitly create a PR.
- `after_publish`: after a successful non-empty branch publication, attempt PR creation automatically.
- `pullRequestDraft: true`: create the PR as draft.

Before PR creation the Forger verifies that the target branch still points to the exact published reviewed commit. A matching open head/base PR is reused instead of duplicated. If automatic PR creation fails after successful branch publication, the branch stays published and the PR error is surfaced separately.

## Event-sourced interview state

The authoritative interview history is append-only NDJSON. Snapshot state is a cache. A session can be resumed by durable `sessionId`, and replay rejects event sequence gaps instead of silently reconstructing partial state.

Finalization exports `.allascode/interview-events.ndjson` with the generated Blueprint.

## Tests and conformance

CI runs:

```text
blueprint:verify
      ↓
runtime:verify
      ↓
npm test
      ↓
npm run build
```

Coverage includes semantic identity, deterministic 2flow, proof/evidence gates, Event Sourcing replay, tenant isolation, mandatory MCP tenant context, canonical runtime-model vectors, repository staleness, golden Blueprint materialization, quotas, workspace retention and real MCP stdio conformance.

## Interview phases

1. System purpose/non-goals.
2. Contexts and actors.
3. Entities and semantic identity.
4. Semantic types.
5. Intents.
6. AtomicAction Behaviors / Domain Actions.
7. Invariants and policies.
8. Causal flows/events.
9. Capabilities/integrations.
10. State, recovery and data.
11. Review/finalization.

## AtomicAction output

When the conversation yields an Action, the MCP materializer creates a package with docs, manifest/config/interface, schemas, fixed Ok/Error events, invariant/forbidden/self-healing specifications, micro `SKILL.md` and an implementation placeholder. Its provenance records the exact pinned Blueprint commit. Later turns refine the same canonical artifact instead of duplicating semantic identities.

See [`skills/allascode-project-forger/SKILL.md`](skills/allascode-project-forger/SKILL.md), [`docs/HOSTED_SECURITY.md`](docs/HOSTED_SECURITY.md), and [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md).
