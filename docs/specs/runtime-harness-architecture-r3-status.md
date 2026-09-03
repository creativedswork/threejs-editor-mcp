# Runtime Harness Architecture R3 Status

Updated: 2026-09-04T02:46:48+0800
Milestone: R3 Make the coordinator the real owner
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`
Next milestone: R4 Simplify Harness authority
Base: `98082f6d49c962b91d37027cb59cb16e633aa743`
Candidate implementation: `85edb8f7f5f8a6e555d334f92f8e2bd78bd2a86a`
Branch: `main`

## Scope

R3 moves the active Runtime frame, execution, build, evidence token, candidate,
validation execution, and lifecycle phase/epoch into one coordinator aggregate.
Lifecycle resources may change only through coordinator state transitions. UI
and model context derive from committed coordinator snapshots.

Exit criterion: no lifecycle resource has a second mutable owner in
`src/view.ts`.

## Slice Ledger

| Slice | State | Commit | Owned scope |
|---|---|---|---|
| 1. Coordinator aggregate/state API | `COMMITTED_LOCAL` | `856a520` | Extended the existing `RuntimeTransitionController` into the single coordinator API; retained only a compatibility export for existing non-R3 callers. |
| 2. Lifecycle migration and publication | `COMMITTED_LOCAL` | `ed192d4` | R3-only hunks in `src/view.ts` remove independent active/candidate/validation resource owners and publish from committed snapshots. |
| 3. Coordinator invariant matrix | `COMMITTED_LOCAL` | `85edb8f` | Focused pure coordinator cases in `tests/runtime-lifecycle.test.mjs`, plus the promotion invariant that atomically invalidates prior validation state. |

## Recovered Baseline

- Repository: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
- Branch: `main`
- HEAD: `98082f6d49c962b91d37027cb59cb16e633aa743`
- R2 implementation commits: `61020fa`, `7b0273e`, and `5c980b1`.
- R2 candidate and acceptance commits: `5b29c1e` and `98082f6`.
- Staged state: empty.
- No repository-local or parent `AGENTS.md` applies to this checkout.
- Relevant pre-edit SHA-256 values:
  - `src/runtime-lifecycle.ts`:
    `e9051af5089fc932551f68a43374d42ca3307845f6c51f3e96d1f2695e9c6ff1`
  - `src/view.ts`:
    `05d948c7ae5d685cce94049853e8b98cae4b734f24b4546534dbfb19755a6008`
  - `tests/runtime-lifecycle.test.mjs`:
    `06051a6e4fdc769e2b4a84517a4c641cd22f89286f1b2e26d979b2fc7ec988e0`
  - `docs/specs/runtime-harness-architecture-r2-status.md`:
    `8d1167d260066ae27117604e331140fec81c02a5fd727937858eee888f599025`
  - `docs/COMPLEX-GAME-EDITOR-PLAN.md`:
    `97f1a0df76a23a71b0c410a61f6730125474b9037bccaf13a381ba3e237bcbd8`
  - `docs/specs/runtime-harness-architecture-audit.md`:
    `2906100342bbcfe7739cea26240fb45cdca3a5de630789ae4f58e1faf5e8bdc9`
- Modified tracked files at baseline:
  `docs/specs/editor-continuity.md`, `reports/M9-ui-stage.log`,
  `src/builder.ts`, `src/m7-runtime.ts`, `src/server.ts`, `src/view.ts`,
  `src/workspaces.ts`, `tests/m7-browser.mjs`, `tests/m7-builder.test.mjs`,
  `tests/m7-pointer-interaction.test.mjs`, `tests/m81-browser.mjs`,
  `tests/m81-continuity.test.mjs`, `tests/m9-ui-browser.mjs`, and
  `tests/runtime-registry.test.mjs`.
- Existing untracked debug, evidence, design, fixture, and Harness browser
  artifacts remain excluded.

## Explicit Exclusions

- R4 `runtimeRef`, independent validation identity, command-bound evidence
  token, active authority, and broker outcome changes except mechanical
  compatibility required to preserve the dirty checkout.
- R5 flat-identity deletion, compatibility cleanup, debug-probe removal, and
  collector cleanup.
- M9 builder, server, browser, fixture, report, and asset work.
- Existing dirty changes outside exact R3 hunks.
- Full suite, full typecheck, lint, production build, package checks,
  independent review, browser soak, push, amend, rebase, PR, deployment, and
  process or port cleanup.

## Release Hardening Ledger

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Exercise coordinator cancellation, timeout, candidate replacement,
  validation disposal, projection recovery, reconnect, and teardown in a real
  browser.
- Revalidate R3 with the accepted R4 authority/evidence model and R5 cleanup.
- Run five browser lifecycle cycles and the 50-cycle Snow soak after all R
  milestones are accepted.

## Milestone Self-Test

- Source under test: committed HEAD
  `85edb8f7f5f8a6e555d334f92f8e2bd78bd2a86a`, checked out in a fresh detached
  worktree so unrelated working-tree changes could not affect the result.
- Focused test: `node --test tests/runtime-lifecycle.test.mjs` passed `7/7` in
  516 ms.
- Focused source bundle:
  `bun build src/view.ts --target=browser --outfile=/tmp/threejs-r3-selftest-view.js`
  passed in 475 ms.
- Ownership check confirmed committed `src/view.ts` has no mutable
  `runtimeFrame`, `m7ActiveRun`, `m7StartingRun`, `m7StartToken`, `m7Build`,
  `m7EvidenceToken`, `m7ValidationRun`, or `m7Bundle` owner, and uses
  `RuntimeCoordinator` mutation methods for aggregate replacement.
- The first ownership grep matched the unrelated telemetry counter
  `m7BuildRequests`; the corrected exact-name check passed.
- The temporary `.r3-worktree/` and `.r3-selftest/` isolation artifacts were
  removed before candidate completion.
- Functional implementation took tens of minutes; the concentrated self-test
  took under one minute.

## Acceptance

1. Review commits `856a520`, `ed192d4`, and `85edb8f`.
2. Confirm the focused coordinator test reports seven passing cases.
3. Confirm candidate promotion publishes active execution, frame, build,
   evidence token, and mode in one coordinator snapshot and clears the
   candidate and prior validation together.
4. Confirm projection updates and validation lifecycle changes use
   coordinator CAS/epoch methods rather than mutable lifecycle globals.
5. Confirm model context and Runtime mode UI derive from stable committed
   coordinator snapshots.

Expected result: `src/view.ts` has one mutable owner for the specified Runtime
lifecycle resources. Failure is any independent mutable owner, stale
candidate/validation mutation replacing newer state, or model context
publication from an uncommitted candidate.

## EXECUTION_CHECKPOINT (CLOSED)

- Updated at: 2026-09-04T02:46:48+0800
- Milestone: R3 Make the coordinator the real owner
- Slice: all Slices
- Phase: milestone-candidate
- Slice state: `COMMITTED_LOCAL`
- Completed facts: accepted R2 baseline and mixed dirty tree were verified.
  Slice 1 introduced the immutable coordinator snapshot and CAS/epoch-checked
  active, candidate, and validation APIs in commit `856a520`. Slice 2 removed
  the independent active frame/run/build/token/candidate/validation owners
  from committed `src/view.ts` in `ed192d4`; the clean staged source passed a
  focused Bun bundle, exact staged content matched the isolated source, the
  commit was reread, and the index is empty. Slice 3 added the coordinator
  invariant matrix and committed it as `85edb8f`. The committed-HEAD
  concentrated self-test passed.
- Repository state: `main` at
  `85edb8f7f5f8a6e555d334f92f8e2bd78bd2a86a`; index empty; pre-existing
  tracked and untracked work listed above remains.
- Intended changes: this STATUS only, for the docs-only candidate commit.
- Explicit exclusions: all items in Explicit Exclusions; especially no R4,
  R5, M9, debug-probe, browser, process, port, or remote work.
- Verification: Slice 1 passed focused Bun import and diff checks. Slice 2
  passed isolated `bun build src/view.ts --target=browser`, worktree and cached
  diff checks, exact staged SHA-256 comparison, commit reread, and post-edit
  hash stability checks. Slice 3 passed `node --check`, focused Bun import,
  diff checks, commit reread, and post-edit hash stability checks. The
  committed-HEAD self-test passed all seven focused tests, the focused browser
  bundle, and the exact ownership-source check.
- Evidence paths: this STATUS and the canonical Plan/audit/R2 STATUS.
- Run identity: N/A; R3 uses pure checks and no browser or external Runtime.
- Continuity constraints: preserve every unrelated dirty hunk; stage only
  exact R3 hunks; re-read and hash each target before editing, then wait at
  least five seconds and verify its hash and target diff.
- Invalidators: branch or HEAD changes, unknown staged content, target hash
  changes outside an owned patch, or inability to separate an R3 hunk from
  excluded work.
- Blockers and risks: no R3 blocker. Real browser lifecycle validation and
  cumulative repository gates remain deferred to Release Hardening.
- Exact next action: parent records the R3 candidate while continuous R4-R5
  execution proceeds under fresh Milestone Owners as already authorized.
- Stop condition: R3 is at `MILESTONE_CANDIDATE / AWAITING_ACCEPTANCE`; this
  Owner performs no R4/R5/M9 or remote operation.
