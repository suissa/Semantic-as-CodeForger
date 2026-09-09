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

## v0.4 — semantic graph, 2flow, proofs and replay implemented

- [x] First-class `relationship` and `identity_rule` artifacts.
- [x] Materialized `identity/graph.yml` with cross-Entity identity and behavior-completing relationships.
- [x] Canonical-characteristic and composite-identity validation.
- [x] Deterministic 2flow parser and AST generation.
- [x] Mermaid `.mmd` visualization derived only from the deterministic AST.
- [x] First-class `proof_obligation` and `evidence` artifacts.
- [x] Agda stubs generated only for explicitly eligible proof kinds.
- [x] Validation that prevents tests/logs/runtime events from being promoted to formal proof by themselves.
- [x] Append-only interview Event Sourcing in NDJSON.
- [x] State reconstruction from the event stream when the snapshot cache is absent.
- [x] Sequence-gap detection during replay.
- [x] Resume UI by durable session id.
- [x] Export interview event stream with the finalized Blueprint.

## v0.5 — conformance and pull-request delivery implemented

- [x] Deterministic repository review policy extracted from the GitHub transport.
- [x] Unit coverage for added/modified/unchanged blob classification.
- [x] Unit coverage for stable review tokens independent from iteration order.
- [x] Explicit stale-workspace, stale-base, stale-target and target-appeared-after-review tests.
- [x] Golden Blueprint fixture spanning Domain Action, fixed Ok/Error, self-healing, identity graph, 2flow and Agda stub generation.
- [x] Golden tree comparison so structural drift breaks CI.
- [x] Real MCP stdio conformance test that lists tools, initializes a session, upserts a Domain Action and verifies the governed materialized tree.
- [x] Optional `manual` or `after_publish` Pull Request delivery policy.
- [x] Optional draft Pull Request policy.
- [x] Manual Pull Request creation as a separate MCP/API operation after branch publication.
- [x] Auto Pull Request creation after successful non-empty reviewed publication when configured.
- [x] Refuse PR creation if the published target branch moved after publication.
- [x] Reuse an existing open head/base Pull Request instead of creating duplicates.
- [x] Preserve successful branch publication even if automatic PR creation fails; expose the PR delivery error separately.

## v0.6 — hosted isolation, canonical runtime contract and hardening implemented

- [x] Provider-neutral `disabled|oidc` authentication mode.
- [x] OIDC JWT signature, issuer, audience and allowed-algorithm verification with remote JWKS/discovery.
- [x] Tenant derived only from a verified claim; secure default is `sub`, configurable for organization claims.
- [x] Raw tenant identifiers never become filesystem paths; hosted tenant namespaces use SHA-256-derived opaque directories.
- [x] Backward-compatible `local` workspace layout when authentication is disabled.
- [x] AsyncLocalStorage tenant context so every internal mutation in one MCP call stays in the authenticated namespace.
- [x] `tenantId` required on every MCP tool and rejected when absent.
- [x] Concurrent tenant-isolation and MCP-boundary tests.
- [x] Pin canonical `suissa/AllasCode` independent-model schema and official valid/invalid vectors in `runtime.lock.json`.
- [x] Recalculate Git blob SHAs for every vendored runtime-contract file in CI.
- [x] Optional byte-for-byte remote verification where a private-upstream credential is explicitly available.
- [x] Validate official AllasCode model test vectors using JSON Schema Draft 2020-12.
- [x] Generate and validate `allascode.model.json` for every forged project.
- [x] Stamp generated projects with `.allascode/runtime.lock.json` and `docs/RUNTIME_CONFORMANCE.md`.
- [x] Revalidate the runtime boundary before finalization.
- [x] Per-tenant HTTP request rate limit with standard reset/retry headers.
- [x] MCP-level artifact, turn, fact, message and artifact-byte quotas so direct MCP callers cannot bypass API limits.
- [x] Request IDs, security headers, bounded JSON input and configurable server timeouts.
- [x] Append-only operational audit log containing only hashed tenant/subject identities; credentials and request bodies are never logged.
- [x] Configurable workspace retention for both legacy local sessions and hosted tenant namespaces.
- [x] Workspace GC is dry-run by default and requires explicit `--apply` to delete expired sessions.

## Next slices

1. Replace the process-local rate limiter with a shared/distributed limiter when horizontal multi-instance hosting is introduced.
2. Add durable shared workspace/object storage before deploying more than one application instance; the current filesystem isolation is intentionally single-node.
3. Add audit-log rotation/export/signing policy if compliance-grade operational evidence is required.
4. Expand repository conformance with a disposable GitHub test repository in CI when a safe scoped cross-repository test credential is available.
5. Add a first-party browser OIDC login/session flow only if the hosted product should not rely on a trusted same-origin identity proxy.
6. Add optional generated-code phase only after semantic acceptance, keeping generated implementation separate from the semantic source of truth.
