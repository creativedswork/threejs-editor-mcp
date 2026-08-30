# Runtime Lifecycle Recovery M1 Status

Updated: 2026-08-30
Milestone: M1 Single transition owner
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`
Base: `bd2bc9`

## Scope

M1 adds one local `RuntimeTransitionController`, routes Play, Stop, Save,
Reload, and external snapshot adoption through its serialized queue, projects
lifecycle UI from controller snapshots, and isolates bounded model-context and
diagnostics work after stable commits.

Phase 2 candidate Runtime, prepared/committed registry operations, build
promotion/cache changes, and Phase 3 authoritative Save are excluded.

## Slice Ledger

| Slice | State | Commit | Result |
|---|---|---|---|
| 1. Controller core | `COMMITTED_LOCAL` | `470a40c` | Added the serialized controller, epoch/cancellation/deadline ownership, stable idle barrier, invariants, and focused tests. |
| 2. Lifecycle integration | `COMMITTED_LOCAL` | `0b1f92c` | Routed Play, Stop, Save, Reload, and external snapshots through the controller; UI and Runtime messages use its snapshot epoch. |
| 3. Effects and cleanup | `COMMITTED_LOCAL` | `93106e7` | Isolated bounded model-context and diagnostics effects; all primary, quality, and parameter Save paths use one final unlock path. |

## Dirty Work Excluded

- `src/view.ts` and `src/server.ts` contain active
  `play-stop-restore-failure` probes that must remain on disk and outside M1
  commits.
- Existing changes in M9, stdio, builder, workspaces, server, fixtures,
  reports, `.dbg`, and debug notes are unrelated and remain excluded.
- `docs/specs/runtime-lifecycle-recovery.md` is an existing untracked design
  input and remains excluded.

## Concentrated Self-Test

- `node --experimental-strip-types --test tests/runtime-lifecycle.test.mjs tests/runtime-effects.test.mjs tests/m7-pointer-interaction.test.mjs`
  passed: 20 tests.
- Targeted TypeScript compilation of `src/view.ts`, `src/m7-runtime.ts`,
  `src/runtime-lifecycle.ts`, and `src/runtime-effects.ts` passed.
- `node --check tests/m7-browser.mjs` and `git diff --check` passed.
- Port 3080 had no listening service. The M0 `immediateSaveRace` browser smoke
  was not run because M1 must not start or reuse the user's service.
- Implementation took tens of minutes; the concentrated automated self-test
  took under one minute of command runtime.

## Release Hardening

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Run five Play/Stop/immediate-Save browser cycles and at least 50 real Snow
  Play/Stop/Save soak cycles.
- Run the updated M0 `immediateSaveRace` path against an explicitly provided
  fresh service; require Save to begin while the delayed model-context effect
  remains outside the lifecycle busy state.
- Cover Runtime context loss and Phase 2/3 candidate/registry/authoritative
  persistence paths when those phases are implemented.

## Acceptance

Target:

- Lifecycle commands never overlap.
- Old-epoch events cannot mutate lifecycle state.
- UI interaction is available only in committed stable phases.
- Model-context and diagnostics failures do not change the committed Runtime
  or lifecycle phase.
- Every Save exit settles by its deadline and releases UI controls.
- M0 immediate-Save behavior remains valid.

The milestone must stop at `MILESTONE_CANDIDATE / AWAITING_ACCEPTANCE`.

## Manual Acceptance

1. Open a Workspace project and wait for `lifecycle.phase === "edit-ready"`.
2. Run Play, Stop, and immediate Save; each command must settle serially and
   controls must only enable again in `edit-ready`.
3. Delay or reject model-context and diagnostics requests; the committed
   Runtime identity and phase must remain unchanged.
4. Inject an old-epoch Runtime event; hierarchy, selection, revision, and phase
   must remain unchanged.

Failure is any overlapping operation, stale event mutation, Save left in
`saving`, host effect changing the Runtime phase, or regression in the final
clean revision and saved transform.

No push, amend, rebase, Phase 2, Phase 3, external repository change, service
restart, or debug-probe cleanup was performed.
