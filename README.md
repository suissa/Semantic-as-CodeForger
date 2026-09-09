# Semantic-as-Code Forger

A fullstack TypeScript application that turns a conversation about a system into an incrementally materialized **AllasCode Blueprint**.

The web UI behaves like an architecture interview. The backend extracts semantic artifacts and, instead of writing project files directly, acts as an **MCP client**. A dedicated MCP server is the mutation boundary that creates, validates and can publish the finalized project tree.

## Why this shape

The Forger deliberately separates responsibilities:

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
Repository review gate
      ↓ explicit approval
GitHub branch
```

This keeps LLM reasoning probabilistic while project mutation is deterministic. The model cannot choose arbitrary paths or rename structural result events.

## AllasCode rules encoded

- Intent is modeled as an immutable desired outcome.
- Reusable `atomic_behavior` is distinct from an Intent-instantiated `domain_action`.
- Domain Actions receive their listened event from the flow.
- Concrete behavior result consequences are always `.Ok` and `.Error`; they are not configurable.
- Error consequences always carry a self-healing obligation and can fall back to Human-in-the-Healing-Loop.
- Semantic identity is captured before storage/transport concerns.
- The interviewer preserves unknowns instead of fabricating domain rules.
- Implementation is intentionally deferred until the semantic contract is accepted.
- Repository publication is impossible without an explicit, fresh diff review.

The materializer covers Agents, Entities/Properties, semantic Types, Contexts, Intents, AtomicAction Behaviors, Domain Actions, Flows, Events, Policies, Constraints, Capabilities, Infrastructure and architecture decisions.

## Pinned AllasCode-Blueprint source

Generation is reproducible against `blueprint.lock.json`. The lock currently pins:

```text
suissa/AllasCode-Blueprint
838f8488adcf5bc7e109efe8ebcf8a5380af1872
```

The lock records the Git blob SHA of every upstream structural/schema source used by the renderer. CI downloads those exact files from the pinned commit and recalculates Git blob hashes before allowing the application build to pass.

```bash
npm run blueprint:verify
npm run blueprint:sync
```

`blueprint:verify` verifies the remote pin without writing a cache. `blueprint:sync` performs the same integrity verification and stores the exact pinned sources under `.forger-cache/blueprint/<commit>/` for inspection/offline tooling.

Every generated project receives `.allascode/blueprint.lock.json` and `docs/BLUEPRINT_SOURCE.md`, so its source structure and compatibility policy remain traceable after ZIP export or GitHub publication.

The pinned Blueprint contains some older prose examples using `success/failure`. Those examples are treated as legacy documentation, not current runtime semantics. The compatibility overlay in `blueprint.lock.json` makes current AllasCode rules authoritative: Action terminal consequences are exactly `Ok` and `Error`, are non-configurable, and `Error` enters mandatory self-healing.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

- Web: `http://localhost:5173`
- API: `http://localhost:8787`
- MCP server can also be run directly with `npm run mcp`.

For structured extraction, configure any OpenAI-compatible chat-completions provider:

```bash
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-5
```

Without an API key the interview still runs deterministically and preserves answers/facts, but it does not attempt rich artifact extraction from free-form language.

To publish reviewed Blueprints to GitHub, configure a narrowly scoped token:

```bash
FORGER_GITHUB_TOKEN=...
```

Read access is sufficient to build a review. Publishing requires repository Contents write permission. The token is read only by the backend/MCP process and is never persisted into Forge state or generated project files.

## API

- `POST /api/sessions` — start a project interview.
- `GET /api/sessions/:id` — current state/tree/validation.
- `POST /api/sessions/:id/messages` — answer the next interview question.
- `POST /api/sessions/:id/finalize` — freeze summary + trace.
- `GET /api/sessions/:id/export` — download the generated Blueprint as ZIP.
- `POST /api/sessions/:id/repository/target` — configure `owner/repo`, base branch, review branch and optional path prefix.
- `POST /api/sessions/:id/repository/review` — compute a non-mutating diff and mint its review token.
- `POST /api/sessions/:id/repository/publish` — publish only the exact reviewed diff.

## MCP tools

- `forger_session_init`
- `forger_artifact_upsert`
- `forger_session_record_turn`
- `forger_session_snapshot`
- `forger_finalize`
- `forger_repository_target_set`
- `forger_repository_review`
- `forger_repository_publish`

The backend spawns the MCP server over stdio and uses those tools for every persisted mutation. The server writes only inside `.forger-workspaces/<session>/project` and sanitizes all project path segments.

## Repository review gate

Publication is intentionally a three-step operation:

1. Configure a GitHub target. If no review branch is supplied, the Forger derives `forger/<project>-<session>`.
2. Generate a review. The MCP server reads the remote Git tree and compares Git blob hashes without writing anything to the repository.
3. Explicitly approve and publish using the generated review token.

The token binds repository, destination branch/path, parent commit SHA and the exact hash of every generated file. Publish is rejected if:

- the workspace changed after review;
- the base/target branch moved after review;
- a different review token is supplied;
- the same review was already published.

The publisher overlays only generated files. Existing remote files that are absent from the Forger workspace are preserved rather than deleted.

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

When the conversation yields an Action, the MCP materializer immediately creates a package with human docs, manifest/config/interface, schemas, fixed Ok/Error events, invariant/forbidden/self-healing specifications, a micro `SKILL.md`, and an implementation placeholder. Its source provenance records the exact pinned Blueprint commit. Later interview turns refine the same canonical artifact rather than creating duplicates.

See [`skills/allascode-project-forger/SKILL.md`](skills/allascode-project-forger/SKILL.md) for the backend agent operating protocol and [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the roadmap.
