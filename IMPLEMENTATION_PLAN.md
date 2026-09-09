# Implementation Plan

## Goal

Build a TypeScript fullstack Semantic-as-Code Forger that interviews a user about a system and incrementally materializes the AllasCode Blueprint through a governed MCP boundary.

## v0.1 — implemented

- [x] React/Vite conversational UI.
- [x] Express TypeScript backend.
- [x] 11-phase semantic interview state machine.
- [x] Optional OpenAI-compatible structured extraction with deterministic no-key fallback.
- [x] Real backend MCP client over stdio.
- [x] MCP server with isolated per-session workspaces.
- [x] Governed artifact upsert instead of arbitrary filesystem access.
- [x] Blueprint materializer for Agents, Entities, Properties, Types, Contexts, Intents, Atomic Behaviors, Domain Actions, Flows, Events, Policies, Constraints, Capabilities, Infrastructure and ADRs.
- [x] AtomicAction package generation with fixed Ok/Error result consequences and mandatory self-healing spec.
- [x] Blueprint validation findings.
- [x] Interview trace + final project summary.
- [x] ZIP export.
- [x] Complete backend agent skill.

## v0.2 — repository delivery implemented

- [x] GitHub repository target configuration (`owner/repo`, base branch, target branch and optional path prefix).
- [x] Repository operations exposed only through MCP tools.
- [x] Non-mutating diff review based on Git tree/blob SHAs.
- [x] Review token bound to repository, destination, parent SHA and exact generated file hashes.
- [x] Stale workspace detection between review and publish.
- [x] Stale target/base branch detection between review and publish.
- [x] Explicit UI approval gate before publication.
- [x] Default isolated review branch `forger/<project>-<session>`.
- [x] Preserve remote files not owned by the generated workspace; no implicit deletion.
- [x] GitHub token kept server-side and outside generated Forge state.

## Next slices

1. Synchronize schemas/templates from a pinned AllasCode-Blueprint version instead of keeping the minimal materializer embedded.
2. Add explicit relationship/identity graph artifacts and canonical-characteristic validation.
3. Add 2flow AST generation and visualization from captured flows.
4. Add formal proof-obligation artifacts and Agda stubs only for invariants eligible for formalization.
5. Add Event Sourcing for interview state itself and resume sessions by durable session id.
6. Add authentication and multi-tenant workspace isolation before hosted use.
7. Add unit/integration/MCP conformance tests and golden Blueprint fixtures, including repository review staleness cases.
8. Add automatic pull-request creation after branch publication as an optional policy distinct from direct branch materialization.
9. Add GitHub Actions validation against the canonical AllasCode schemas/runtime when those interfaces stabilize.
