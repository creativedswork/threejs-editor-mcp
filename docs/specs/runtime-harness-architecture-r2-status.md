# Runtime Harness Architecture R2 Status

Updated: 2026-09-03T17:18:57Z
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
| 1. Projection transaction boundary | `IMPLEMENTED` | pending | Narrow R2 hunks in `src/workspaces.ts`, `src/server.ts`, `src/view.ts`, and the `apply-operations` acknowledgement in `src/m7-runtime.ts`; this STATUS |
| 2. Committed-revision recovery | `PENDING` | pending | Narrow R2 recovery hunks in `src/view.ts`; this STATUS |
| 3. Projection invariant matrix | `PENDING` | pending | R2-only cases in `tests/runtime-registry.test.mjs`; this STATUS |

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

- Updated at: 2026-09-03T17:18:57Z
- Milestone: R2 Complete authoritative projection
- Slice: 1. Projection transaction boundary
- Phase: commit
- Slice state: `IMPLEMENTED`
- Completed facts: R1 was accepted at `655cb62`; branch, HEAD, index, dirty
  files, canonical documents, and relevant hashes were verified from disk.
  The Workspace commit now creates a pending projection under the same project
  lock; the iframe echoes its transition ID; the registry advances only after
  a matching acknowledgement and execution/generation CAS.
- Repository state: `main` at `655cb62f25814f47f88c5bfab21e855dd73bfd9b`;
  the index contains only this STATUS and exact R2 hunks in
  `src/workspaces.ts`, `src/server.ts`, `src/view.ts`, and
  `src/m7-runtime.ts`; all other dirty and untracked paths are excluded.
- Intended changes: isolate the smallest R2-only locked mutation and pending
  projection hunks in `src/workspaces.ts`, app-tool plumbing in `src/server.ts`,
  transition-bound iframe acknowledgement in `src/m7-runtime.ts`, and
  acknowledgement/CAS orchestration in `src/view.ts`, without taking ownership
  of whole mixed files.
- Explicit exclusions: all items in the Explicit Exclusions section; no
  process, port, remote, cleanup, or release-hardening operation.
- Verification: post-edit hashes remained stable after more than five seconds;
  `git diff --check` and `node --experimental-strip-types --check` passed for
  the four touched source files. Functional tests remain deferred to the one
  concentrated R2 self-test.
- Evidence paths: this STATUS and the canonical plan/spec documents named in
  the milestone request.
- Run identity: N/A; no browser or external Runtime smoke is active for R2.
- Continuity constraints: preserve the exact unrelated dirty tree and empty
  index; re-read and hash every target before editing; wait at least five
  seconds and re-hash after each edit.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to separate an R2 hunk from
  excluded R4/M9/debug work.
- Blockers and risks: `src/workspaces.ts`, `src/server.ts`, and `src/view.ts`
  contain mixed work; whole-file staging is forbidden.
- Exact next action: stage only the documented Slice 1 hunks, inspect cached
  name-status/check/diff, and create the local atomic commit.
- Stop condition: stop at an ownership ambiguity that cannot be resolved from
  Git and call-site evidence, or after R2 reaches
  `MILESTONE_CANDIDATE / AWAITING_ACCEPTANCE`.
