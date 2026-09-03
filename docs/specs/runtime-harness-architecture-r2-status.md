# Runtime Harness Architecture R2 Status

Updated: 2026-09-03T17:58:44Z
Milestone: R2 Complete authoritative projection
State: `IMPLEMENTING_SLICES`
Gate: `IMPLEMENTING_SLICES`
Base: `655cb62f25814f47f88c5bfab21e855dd73bfd9b`
Branch: `main`

## Scope

R2 commits an Editor mutation and pending Runtime projection under one project
lock, advances the registry only after an iframe acknowledgement bound to that
pending transition, and recovers every failed projection from the committed
Workspace revision without compensating browser rollback.

The acceptance target is eventual convergence of Workspace, registry, and
iframe after success, timeout, cancellation, reconnect, and acknowledgement
failure.

## Slice Ledger

| Slice | State | Commit | Owned scope |
|---|---|---|---|
| 1. Projection transaction boundary | `COMMITTED_LOCAL` | `61020fa` | Narrow R2 hunks in `src/workspaces.ts`, `src/server.ts`, `src/view.ts`, and the `apply-operations` acknowledgement in `src/m7-runtime.ts`; this STATUS |
| 2. Committed-revision recovery | `COMMITTED_LOCAL` | `7b0273e` | Narrow R2 recovery hunks in `src/workspaces.ts` and `src/view.ts`; this STATUS |
| 3. Projection invariant matrix | `IMPLEMENTING` | pending | R2-only cases in `tests/runtime-registry.test.mjs`; this STATUS |

## Recovered Baseline

- Repository: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
- Branch: `main`
- HEAD: `655cb62f25814f47f88c5bfab21e855dd73bfd9b`
- R1 acceptance closeout resolves to the same commit.
- Staged state: empty.
- No repository-local or parent `AGENTS.md` applies to this checkout.
- Relevant pre-edit SHA-256 values:
  - `src/workspaces.ts`:
    `c76aae53e2450c2f0da4b5be1b189f99a2d55d84a5936c957552f63c2f452195`
  - `src/view.ts`:
    `ff925524eafd7004a4fa17dcad636ac2f9cf7b27cb62ae1f00a46bdb71969ccd`
  - `src/m7-runtime.ts`:
    `a2a87d2005b1afbab7762360ed67827f90306e9e60456c805f77aa060694ef06`
  - `tests/runtime-registry.test.mjs`:
    `dae86f47c061f7bda7ef90f4afdbe3cf2b259a561655ab9ce99703ce53042676`
  - `docs/specs/editor-continuity.md`:
    `7dc7d832827c9395983c138c2ebb255ad9a21e0d6046e267c0551da540cafc2d`
  - `docs/specs/runtime-harness-architecture-audit.md`:
    `2906100342bbcfe7739cea26240fb45cdca3a5de630789ae4f58e1faf5e8bdc9`
  - `docs/specs/runtime-lifecycle-recovery.md`:
    `9a1854145a96e5acaf3d7248d1488ac25efe10b877a943f9b218bb96305ed9e9`
- Modified tracked files at recovery:
  `docs/specs/editor-continuity.md`, `reports/M9-ui-stage.log`,
  `src/builder.ts`, `src/m7-runtime.ts`, `src/server.ts`, `src/view.ts`,
  `src/workspaces.ts`, `tests/m7-browser.mjs`, `tests/m7-builder.test.mjs`,
  `tests/m7-pointer-interaction.test.mjs`, `tests/m81-browser.mjs`,
  `tests/m81-continuity.test.mjs`, `tests/m9-ui-browser.mjs`, and
  `tests/runtime-registry.test.mjs`.
- Untracked files at recovery:
  `.dbg/`, all `debug-*.md` files, the architecture and lifecycle design
  drafts, lifecycle diagram reports, M6 fixture artifacts, and Harness
  browser/page tests.

## Explicit Exclusions

- R3 coordinator ownership refactor.
- R4 `runtimeRef`, authority, validation execution, evidence-token, and broker
  settlement work.
- R5 legacy cleanup and every debug probe, collector, note, log, fixture, and
  evidence artifact.
- M9 builder, server, browser, fixture, report, and asset work.
- Existing edits to `docs/specs/editor-continuity.md`, `src/builder.ts`, all
  non-acknowledgement hunks in `src/m7-runtime.ts`, and all browser tests.
- Full suite, full typecheck, lint, production build, package checks,
  independent review, soak testing, push, amend, rebase, PR, and deployment.
- Existing processes and ports must not be stopped or restarted for inspection.

## Release Hardening Ledger

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Run at least five browser Play/Stop/Save cycles and the 50-cycle real Snow
  soak, checking resource disposal, process memory, and convergence.
- Exercise candidate and projection persistence failure, Runtime context loss,
  malformed acknowledgement, transport interruption, and reconnect ownership
  rollover in real browser/Harness runs.
- Revalidate R2 together with the eventual R3 coordinator aggregate and R4
  opaque authority/evidence protocol.
- Remove debug sessions and probes only under their own accepted cleanup scope.

## EXECUTION_CHECKPOINT

- Updated at: 2026-09-03T17:58:44Z
- Milestone: R2 Complete authoritative projection
- Slice: 3. Projection invariant matrix
- Phase: commit
- Slice state: `IMPLEMENTED`
- Completed facts: R1 was accepted at `655cb62`; branch, HEAD, index, dirty
  files, canonical documents, and relevant hashes were verified from disk.
  Slice 1 was committed as `61020fa`. Slice 2 was committed as `7b0273e`;
  both commits were reread and the index is empty. The Slice 1 follow-up type
  diagnostic was fixed and passed its targeted TypeScript check in Slice 2.
- Repository state: `main` at `7b0273e068763b7a59e7c7428782fc114ddbf53f`;
  the index contains only this STATUS and the standalone appended R2 test in
  `tests/runtime-registry.test.mjs`; the pre-existing unrelated dirty and
  untracked paths remain.
- Intended changes: append one independently staged R2 invariant test to
  `tests/runtime-registry.test.mjs`, proving pending state before
  acknowledgement, stale CAS rejection, exactly one generation advance, and
  candidate convergence after unacknowledged or ambiguously committed
  projection, including a new owner generation after reconnect. The pre-edit
  SHA-256 is
  `dae86f47c061f7bda7ef90f4afdbe3cf2b259a561655ab9ce99703ce53042676`;
  the stable post-edit SHA-256 is
  `67f21e68fb659c5ff8f8ad618d8619a3c890b900211b76929a3b76e15d00671d`.
- Explicit exclusions: all items in the Explicit Exclusions section; no
  process, port, remote, cleanup, or release-hardening operation.
- Verification: Slice 2 passed `git diff --cached --check`; the Slice 1
  follow-up Fix passed its targeted TypeScript command. Slice 3 passed
  `node --check tests/runtime-registry.test.mjs` and `git diff --check`;
  functional execution remains deferred to the one concentrated R2 self-test
  after its local commit.
- Evidence paths: this STATUS and the canonical plan/spec documents named in
  the milestone request.
- Run identity: N/A; no browser or external Runtime smoke is active for R2.
- Continuity constraints: preserve the exact unrelated dirty tree and empty
  index; re-read and hash every target before editing; wait at least five
  seconds and re-hash after each edit.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to separate an R2 hunk from
  excluded R4/M9/debug work.
- Blockers and risks: `tests/runtime-registry.test.mjs` contains pre-existing
  R4 `runtimeRef`/evidence and obsolete `advance_runtime_projection` edits;
  whole-file staging is forbidden.
- Exact next action: create the local Slice 3 commit, reread it and the dirty
  tree, then run the one concentrated R2 self-test.
- Stop condition: stop at an ownership ambiguity that cannot be resolved from
  Git and call-site evidence, or after R2 reaches
  `MILESTONE_CANDIDATE / AWAITING_ACCEPTANCE`.
