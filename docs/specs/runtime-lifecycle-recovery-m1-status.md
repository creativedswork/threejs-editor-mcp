# Runtime Lifecycle Recovery M1 Status

Updated: 2026-08-30
Milestone: M1 Single transition owner
State: `IMPLEMENTING_SLICES`
Gate: `IMPLEMENTING_SLICES`
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
| 3. Effects and cleanup | `IMPLEMENTED` | pending local commit | Isolated bounded model-context and diagnostics effects; all primary, quality, and parameter Save paths use one final unlock path. |

## Dirty Work Excluded

- `src/view.ts` and `src/server.ts` contain active
  `play-stop-restore-failure` probes that must remain on disk and outside M1
  commits.
- Existing changes in M9, stdio, builder, workspaces, server, fixtures,
  reports, `.dbg`, and debug notes are unrelated and remain excluded.
- `docs/specs/runtime-lifecycle-recovery.md` is an existing untracked design
  input and remains excluded.

## Concentrated Self-Test

Pending until all three implementation Slices are committed.

## Release Hardening

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Run five Play/Stop/immediate-Save browser cycles and at least 50 real Snow
  Play/Stop/Save soak cycles.
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
