# Semantic-as-Code Forger

A fullstack TypeScript application that turns a conversation about a system into an incrementally materialized **AllasCode Blueprint**.

The web UI behaves like an architecture interview. The backend extracts semantic artifacts and, instead of writing project files directly, acts as an **MCP client**. A dedicated MCP server is the mutation boundary that creates, validates and can publish the finalized project tree.

## Why this shape

```text
User conversation
      ↓
Semantic interviewer / extractor
      ↓ semantic artifacts
Backend MCP client
      ↓ tool calls
Governed Blueprint materializer
      ↓ pinned Blueprint renderer
AllasCode project tree
      ↓ finalize
Fresh repository review token
      ↓ explicit approval
GitHub review branch
      ↓ optional policy
Pull Request
```

This keeps LLM reasoning probabilistic while project mutation is deterministic. The model cannot choose arbitrary paths, rename structural result events, bypass repository review, or claim a formal proof without explicit formal evidence.

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

Generation is reproducible against `blueprint.lock.json`. The lock currently pins:

```text
suissa/AllasCode-Blueprint
838f8488adcf5bc7e109efe8ebcf8a5380af1872
```

The lock records Git blob SHAs for the upstream structural/schema sources used by the renderer. CI downloads those exact files from the pinned commit and recalculates the Git blob hashes before tests/build are allowed to pass.

```bash
npm run blueprint:verify
npm run blueprint:sync
```

`blueprint:verify` checks integrity without writing a cache. `blueprint:sync` performs the same verification and stores the exact pinned sources under `.forger-cache/blueprint/<commit>/`.

Every generated project receives `.allascode/blueprint.lock.json` and `docs/BLUEPRINT_SOURCE.md`. Older upstream prose that uses `success/failure` is treated as legacy documentation; the compatibility overlay keeps current structural `Ok/Error`, mandatory self-healing and immutable Intent semantics authoritative.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787`
- MCP: `npm run mcp`

For structured extraction, configure any OpenAI-compatible chat-completions provider:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-5
```

Without an API key the interview still runs deterministically and preserves answers/facts, but it does not attempt rich artifact extraction from free-form language.

To review/publish against GitHub, configure a narrowly scoped token:

```bash
FORGER_GITHUB_TOKEN=...
```

Read access is enough for review. Branch publication requires Contents write permission. Pull Request creation additionally requires permission to create pull requests. The token stays server-side and is never written into Forge state or generated project files.

## API

- `POST /api/sessions` — start a project interview.
- `GET /api/sessions/:id` — replay/read current state, tree and validation.
- `POST /api/sessions/:id/messages` — answer the next interview question.
- `POST /api/sessions/:id/finalize` — freeze summary, trace and exported event stream.
- `GET /api/sessions/:id/export` — download the generated Blueprint as ZIP.
- `POST /api/sessions/:id/repository/target` — configure repository/base/review branch/path and PR policy.
- `POST /api/sessions/:id/repository/review` — compute a non-mutating diff and mint its review token.
- `POST /api/sessions/:id/repository/publish` — publish only the exact reviewed diff.
- `POST /api/sessions/:id/repository/pull-request` — open or reuse a PR for the already-published reviewed branch.

Repository target policy fields:

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

The backend spawns the MCP server over stdio and uses it for persisted mutations. The server writes project content only inside `.forger-workspaces/<session>/project` and sanitizes path segments.

## Repository review and staleness gate

Publication is intentionally separate from review:

1. Configure a GitHub target. If no target branch is supplied, the Forger derives `forger/<project>-<session>`.
2. Build a non-mutating review from the remote Git tree and local Git blob hashes.
3. Mint a review token bound to repository, target branch/path, parent SHA and every generated file hash.
4. Publish only when the current workspace and remote parent still match that review.

Publication is rejected when:

- workspace content changed after review;
- the base branch moved after a base-based review;
- the target branch moved after a target-based review;
- a target branch appeared after the review was created from the base branch;
- the supplied token is not the latest review token;
- the review was already published.

Remote files that are not owned by the generated workspace are preserved rather than implicitly deleted.

## Pull Request delivery

Branch materialization is the authoritative write operation. Pull Requests are an optional delivery layer.

- `manual`: publish the reviewed branch first, then explicitly create a PR.
- `after_publish`: after a successful non-empty branch publication, attempt to create the PR automatically.
- `pullRequestDraft: true`: create the PR as draft.

Before PR creation, the Forger verifies that the target branch still points to the exact published reviewed commit. If a matching open PR for the same head/base already exists, it is reused instead of duplicated. If automatic PR creation fails after the branch was successfully published, branch publication remains successful and the PR failure is surfaced separately in state/UI.

## Event-sourced interview state

The authoritative interview history is append-only NDJSON. Snapshot state is a cache. A session can be resumed by durable `sessionId`, and replay rejects event sequence gaps rather than silently reconstructing a partial state.

Finalization exports the event stream to `.allascode/interview-events.ndjson` together with the generated Blueprint.

## Tests and conformance

CI runs:

```text
blueprint:verify
      ↓
npm test
      ↓
npm run build
```

Coverage includes:

- semantic identity/canonical-characteristic rules;
- deterministic 2flow parsing;
- proof/evidence gates and Agda eligibility;
- interview Event Sourcing/replay and sequence gaps;
- repository review token stability and staleness cases;
- a golden Blueprint fixture spanning Domain Action, fixed Ok/Error, self-healing, identity graph, 2flow and Agda output;
- real MCP stdio conformance: list tools → initialize session → upsert Domain Action → inspect governed materialized tree.

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

See [`skills/allascode-project-forger/SKILL.md`](skills/allascode-project-forger/SKILL.md) for the backend agent protocol and [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the roadmap.
