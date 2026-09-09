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

## v0.3 — pinned Blueprint source implemented

- [x] Pin AllasCode-Blueprint by full commit SHA in `blueprint.lock.json`.
- [x] Pin structural/schema source files by their Git blob SHA.
- [x] Verify pinned upstream content byte-for-byte using the Git blob hashing algorithm.
- [x] Add `blueprint:verify` for non-mutating integrity verification.
- [x] Add `blueprint:sync` for verified local source cache generation.
- [x] Run Blueprint integrity verification in CI before TypeScript/Vite build.
- [x] Move AtomicAction rendering behind a pinned Blueprint source/compatibility module instead of keeping it inside the workspace state module.
- [x] Stamp generated projects with `.allascode/blueprint.lock.json` and `docs/BLUEPRINT_SOURCE.md` provenance.
- [x] Stamp generated project and AtomicAction documents with the pinned Blueprint commit/profile.
- [x] Add an explicit compatibility overlay so legacy upstream `success/failure` prose cannot override current structural `Ok/Error`, mandatory self-healing or immutable Intent semantics.

## Next slices

1. Add explicit relationship/identity graph artifacts and canonical-characteristic validation.
2. Add 2flow AST generation and visualization from captured flows.
3. Add formal proof-obligation artifacts and Agda stubs only for invariants eligible for formalization.
4. Add Event Sourcing for interview state itself and resume sessions by durable session id.
5. Add authentication and multi-tenant workspace isolation before hosted use.
6. Add unit/integration/MCP conformance tests and golden Blueprint fixtures, including repository review staleness and Blueprint pin integrity cases.
7. Add automatic pull-request creation after branch publication as an optional policy distinct from direct branch materialization.
8. Add GitHub Actions validation against canonical AllasCode runtime/schema interfaces when those interfaces stabilize.
