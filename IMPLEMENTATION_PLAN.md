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

## Next slices

1. Add native repository target MCP tools so a finalized workspace can be committed to a chosen Git repository with review/diff gates.
2. Synchronize schemas/templates from a pinned AllasCode-Blueprint version instead of keeping the minimal materializer embedded.
3. Add explicit relationship/identity graph artifacts and canonical-characteristic validation.
4. Add 2flow AST generation and visualization from captured flows.
5. Add formal proof-obligation artifacts and Agda stubs only for invariants eligible for formalization.
6. Add Event Sourcing for interview state itself and resume sessions by durable session id.
7. Add authentication and multi-tenant workspace isolation before hosted use.
8. Add unit/integration/MCP conformance tests and golden Blueprint fixtures.
9. Add GitHub Actions validation against the canonical AllasCode schemas/runtime when those interfaces stabilize.
