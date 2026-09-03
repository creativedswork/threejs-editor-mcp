# Runtime Harness Architecture R1 Status

Updated: 2026-09-03T12:43:14+0800
Milestone: R1 Normalize internal Runtime protocol
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`
Base: `f821b929cafbb1bda1d41e5a1c693c73be54617f`
Candidate implementation: `f665b6f69bce001f6bdba5197c05e35f749fe044`
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
| 3. Pure invariant matrix | `COMMITTED_LOCAL` | `f665b6f` | `tests/runtime-protocol.test.mjs`, this STATUS |

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
- Re-run `pnpm run typecheck`, `pnpm run build`, the complete Node suite, and
  the Runtime registry/browser paths after the uncommitted R2/R4 work is
  independently scoped and committed.
- Review the cumulative protocol consumers once R2-R4 migration is complete;
  R1 intentionally retains the flat compatibility adapter.
- R1 self-test is limited to the pure protocol matrix plus `git diff --check`.
- Risk: R1 helpers are consumed by substantial uncommitted R2/R4 work. Each R1
  commit must be assembled and inspected by exact file or hunk so those changes
  are not captured.

## Concentrated Self-Test

- `node --experimental-strip-types --test tests/runtime-protocol.test.mjs`:
  PASS, 8 tests, 0 failures, 0 skips, 461 ms reported test duration and 6.99
  seconds wall time.
- `git diff --check f821b92..f665b6f`: PASS.
- Commit-range audit: only this STATUS, `src/runtime-protocol.ts`, the intended
  hunks in `src/workspaces.ts` and `src/view.ts`, and
  `tests/runtime-protocol.test.mjs`.
- Functional implementation and local commit work took roughly 14 minutes;
  the concentrated self-test took seconds.

## Manual Acceptance

1. Inspect `7014b11`, `80fab31`, and `f665b6f`; require each Slice to contain
   only its ledger scope.
2. Run
   `node --experimental-strip-types --test tests/runtime-protocol.test.mjs`.
3. Require 8 passing tests covering explicit legacy adaptation, all execution
   and projection equality coordinates, one-generation projection advance,
   stale CAS rejection, all terminal outcomes, replay-stable messages, and
   stable protocol error codes.

Acceptance fails if any R1 commit contains an excluded debug/R2/R4 hunk, if a
flat identity bypasses the named compatibility boundary in migrated call
sites, or if any focused invariant fails.

## EXECUTION_CHECKPOINT (CLOSED)

- Updated at: 2026-09-03T12:43:14+0800
- Milestone: R1 Normalize internal Runtime protocol
- Slice: all Slices
- Phase: awaiting-acceptance
- Slice state: `COMMITTED_LOCAL`
- Completed facts: Slices 1-3 are committed as `7014b11`, `80fab31`, and
  `f665b6f`. The concentrated R1 self-test passed 8/8.
- Repository state: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
  on `main`; candidate implementation is `f665b6f`; the index was empty before
  this final STATUS update. All pre-existing unrelated changes remain dirty.
- Intended changes: none; R1 implementation and focused verification are
  complete.
- Explicit exclusions: every pre-existing dirty hunk outside the exact R1
  protocol/equality changes; R2/R3/R4/R5 behavior; all debug sessions,
  collectors, probes, logs, reports, fixtures, and evidence; port `7778`;
  push, amend, rebase, PR, release hardening, and cleanup.
- Verification: focused protocol test PASS 8/8 at `f665b6f`; Slice-targeted
  TypeScript checks and syntax checks PASS; R1 commit-range `git diff --check`
  PASS.
- Evidence paths: this STATUS; `docs/specs/runtime-harness-architecture-audit.md`;
  `src/runtime-protocol.ts`; `tests/runtime-protocol.test.mjs`.
- Run identity: N/A for pure R1 verification. A read-only
  `lsof -nP -iTCP:7778 -sTCP:LISTEN` returned no listener row at checkpoint
  creation; no process or port was stopped, restarted, or otherwise mutated.
- Continuity constraints: preserve the recovered dirty tree, all debug
  evidence and processes, and the exact non-R1 index exclusion.
- Invalidators: any R1 implementation commit changes, a focused test fails on
  the candidate commits, or an excluded hunk enters the R1 commit range.
- Blockers and risks: mixed R2/R4/debug changes remain in
  `src/workspaces.ts` and `src/view.ts`; full integration confidence is deferred
  to Release Hardening after those changes have their own ownership boundary.
- Exact next action: wait for the user's R1 acceptance decision.
- Stop condition: user selects acceptance, further R1 iteration, or stop.
