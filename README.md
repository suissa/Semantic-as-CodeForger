# Semantic-as-Code Forger

A fullstack TypeScript application that turns a conversation about a system into an incrementally materialized **AllasCode Blueprint**.

The web UI behaves like an architecture interview. The backend extracts semantic artifacts and, instead of writing files directly, acts as an **MCP client**. A dedicated MCP server is the mutation boundary that creates and validates the project tree.

## Why this shape

The Forger deliberately separates three responsibilities:

```text
User conversation
      ↓
Semantic interviewer / extractor
      ↓ semantic artifacts
Backend MCP client
      ↓ tool calls
Governed Blueprint materializer
      ↓
AllasCode project tree
```

This keeps LLM reasoning probabilistic while project mutation is deterministic. The model cannot choose arbitrary paths or rename structural result events.

## AllasCode rules encoded in v0.1

- Intent is modeled as an immutable desired outcome.
- Reusable `atomic_behavior` is distinct from an Intent-instantiated `domain_action`.
- Domain Actions receive their listened event from the flow.
- Concrete behavior result consequences are always `.Ok` and `.Error`; they are not configurable.
- Error consequences always carry a self-healing obligation and can fall back to Human-in-the-Healing-Loop.
- Semantic identity is captured before storage/transport concerns.
- The interviewer preserves unknowns instead of fabricating domain rules.
- Implementation is intentionally deferred until the semantic contract is accepted.

The materializer covers the Blueprint families used by the project: Agents, Entities/Properties, semantic Types, Contexts, Intents, AtomicAction Behaviors, Domain Actions, Flows, Events, Policies, Constraints, Capabilities, Infrastructure and architecture decisions.

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

## API

- `POST /api/sessions` — start a project interview.
- `GET /api/sessions/:id` — current state/tree/validation.
- `POST /api/sessions/:id/messages` — answer the next interview question.
- `POST /api/sessions/:id/finalize` — freeze summary + trace.
- `GET /api/sessions/:id/export` — download the generated Blueprint as ZIP.

## MCP tools

- `forger_session_init`
- `forger_artifact_upsert`
- `forger_session_record_turn`
- `forger_session_snapshot`
- `forger_finalize`

The backend spawns the MCP server over stdio and uses those tools for every persisted mutation. The server writes only inside `.forger-workspaces/<session>/project` and sanitizes all path segments.

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

When the conversation yields an Action, the MCP materializer immediately creates a package with human docs, manifest/config/interface, schemas, fixed Ok/Error events, invariant/forbidden/self-healing specifications, a micro `SKILL.md`, and an implementation placeholder. Later interview turns refine the same canonical artifact rather than creating duplicates.

See [`skills/allascode-project-forger/SKILL.md`](skills/allascode-project-forger/SKILL.md) for the backend agent operating protocol and [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) for the roadmap.
