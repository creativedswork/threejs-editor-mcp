# Runtime Harness Architecture R1 Status

Updated: 2026-09-03T12:40:27+0800
Milestone: R1 Normalize internal Runtime protocol
State: `IMPLEMENTING_SLICES`
Gate: `AUTHORIZED`
Base: `f821b929cafbb1bda1d41e5a1c693c73be54617f`
Branch: `main`

## Scope

R1 freezes normalized execution, projection, build, and broker-outcome types;
defines the explicit legacy identity adapter boundary; centralizes identity
equality and stable protocol error mapping; and adds a pure invariant matrix.

R2 projection behavior, R3 coordinator ownership, R4 Harness authority and
settlement behavior, R5 cleanup, release hardening, and remote operations are
excluded.

## Slice Ledger

| Slice | State | Commit | Owned files |
|---|---|---|---|
| 1. Protocol types and legacy boundary | `COMMITTED_LOCAL` | `7014b11` | `src/runtime-protocol.ts`, this STATUS |
| 2. Equality and error mapping migration | `COMMITTED_LOCAL` | `80fab31` | isolated hunks in `src/workspaces.ts` and `src/view.ts`, this STATUS |
| 3. Pure invariant matrix | `IMPLEMENTED` | pending | `tests/runtime-protocol.test.mjs`, this STATUS |

## Recovered Baseline

- `git status --short` and `git diff --cached --name-status` were read before
  implementation. The index was empty.
- Relevant pre-edit SHA-256 values:
  - `src/runtime-protocol.ts`:
    `1f6d9bd068531e2d93fd25b54fbaf09aafb7f89d9f9e99dab52fa456bff2fc2a`
  - `tests/runtime-protocol.test.mjs`:
    `9c7a3bbbc3c70b79312dda9602fc03655ecf121759a6ef076b5710631cfd8f37`
  - `src/workspaces.ts`:
    `d85791728de5d9b80df0911e395cb7555d389a2009240613731ee8305cf8ce8a`
  - `src/view.ts`:
    `e255b808f794eef54419866582d38f915e13ce2ff878c9b20436bf533d69de85`
- The untracked protocol module and test predate this recovery and are treated
  as interrupted R1 drafts only after their complete contents and all call
  sites were audited.
- Modified tracked files present at recovery:
  `docs/specs/editor-continuity.md`, `reports/M9-ui-stage.log`,
  `src/builder.ts`, `src/m7-runtime.ts`, `src/server.ts`, `src/view.ts`,
  `src/workspaces.ts`, `tests/m7-browser.mjs`, `tests/m7-builder.test.mjs`,
  `tests/m7-pointer-interaction.test.mjs`, `tests/m81-browser.mjs`,
  `tests/m81-continuity.test.mjs`, `tests/m9-ui-browser.mjs`, and
  `tests/runtime-registry.test.mjs`.
- Untracked exclusions present at recovery:
  `.dbg/`, all `debug-*.md` files, lifecycle diagrams, fixture artifacts,
  Harness browser/page tests, architecture and lifecycle audit drafts, and
  every other untracked file except the two R1 files named in the Slice ledger
  and this STATUS.

## Release Hardening Ledger

- Full Node tests, browser suites, typecheck, lint, production build, package
  checks, independent review, and soak testing remain deferred.
- R1 self-test is limited to the pure protocol matrix plus `git diff --check`.
- Risk: R1 helpers are consumed by substantial uncommitted R2/R4 work. Each R1
  commit must be assembled and inspected by exact file or hunk so those changes
  are not captured.

## EXECUTION_CHECKPOINT

- Updated at: 2026-09-03T12:40:27+0800
- Milestone: R1 Normalize internal Runtime protocol
- Slice: 3. Pure invariant matrix
- Phase: commit
- Slice state: `IMPLEMENTED`
- Completed facts: Slice 1 committed locally as `7014b11`; commit readback
  contains only `src/runtime-protocol.ts` and this STATUS. The protocol file's
  stable SHA-256 is
  `22b59976b9daf5e0ea75bf9aef7f0601357c6c1c491cd44cca300b2de8e33157`.
  Server and client compatibility comparisons now delegate to the centralized
  helpers. Active-runtime stale and foreign failures now carry stable codes.
  Slice 2 committed locally as `80fab31`; cached and commit readback excluded
  all R2/R4/debug hunks. The pure R1 matrix now covers adapter construction,
  every equality coordinate, projection purity and stale expectations, every
  terminal outcome, replay determinism, and stable error messages. Its stable
  SHA-256 is
  `19b1d668555030a92423cb80002bc45152c138028702cb9d9d2fec3cbbaec940`.
- Repository state: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
  on `main` at `80fab31`; relevant dirty files and exclusions are recorded
  above; no staged files.
- Intended changes: expand only `tests/runtime-protocol.test.mjs` into the
  approved pure constructibility, equality, projection, outcome, and
  idempotency matrix; update this STATUS.
- Explicit exclusions: every pre-existing dirty hunk outside the exact R1
  protocol/equality changes; R2/R3/R4/R5 behavior; all debug sessions,
  collectors, probes, logs, reports, fixtures, and evidence; port `7778`;
  push, amend, rebase, PR, release hardening, and cleanup.
- Verification: baseline and Slice-owned `git diff --check` PASS; direct Node
  ESM import PASS; Slice 1 targeted
  `pnpm exec tsc --ignoreConfig --noEmit --target ES2024 --module NodeNext
  --moduleResolution NodeNext --skipLibCheck src/runtime-protocol.ts` PASS.
  An earlier targeted TypeScript invocation without `--ignoreConfig` exited
  with TS5112 before checking source and was corrected without changing scope.
  Slice 2 targeted TypeScript check of `src/workspaces.ts` and `src/view.ts`
  PASS after restoring the repository's Node type setting; the first invocation
  without `--types node` reported only missing Node globals. Slice 3
  `node --check tests/runtime-protocol.test.mjs` PASS.
- Evidence paths: this STATUS; `docs/specs/runtime-harness-architecture-audit.md`;
  `src/runtime-protocol.ts`; `tests/runtime-protocol.test.mjs`.
- Run identity: N/A for pure R1 verification. A read-only
  `lsof -nP -iTCP:7778 -sTCP:LISTEN` returned no listener row at checkpoint
  creation; no process or port was stopped, restarted, or otherwise mutated.
- Continuity constraints: preserve the recovered dirty tree, all debug
  evidence and processes, and the exact non-R1 index exclusion.
- Invalidators: HEAD changes unexpectedly; any target hash changes outside the
  current patch; any pre-existing file becomes staged; or an R1 cached diff
  contains an excluded hunk.
- Blockers and risks: mixed R2/R4/debug changes remain in
  `src/workspaces.ts` and `src/view.ts`; they must remain unstaged.
- Exact next action: explicitly stage `tests/runtime-protocol.test.mjs` and
  this STATUS, inspect the cached diff, and create the Slice 3 local commit.
- Stop condition: stop at `AWAITING_ACCEPTANCE` after three local Slice commits,
  one concentrated self-test, and final checkpoint/report publication; stop
  earlier only for an ownership ambiguity, concurrent write, failed commit, or
  scope-changing requirement.
