# Runtime Lifecycle Recovery M2 Status

Updated: 2026-08-31
Milestone: M2 Atomic Stop replacement
State: `IMPLEMENTING_SLICES`
Gate: `EXECUTION_AUTHORIZED`
Base: `90a5613`

## Scope

M2 keeps the committed Runtime visible while one candidate prepares away from
the visible surface. Promotion occurs only after matching readiness,
editor-scene acceptance, and an owner-scoped registry CAS. Unchanged Stop
reuses immutable build, validation, and asset artifacts.

Phase 3 authoritative Save, Phase 4 legacy-state removal, full-suite testing,
independent review, release checks, and deployment are excluded.

## Slice Ledger

| Slice | State | Commit | Result |
|---|---|---|---|
| 1. Registry prepare/commit | `IMPLEMENTED` | pending | Owner-scoped prepared run with short expiry and active-run CAS; failed or stale commits leave active unchanged. |
| 2. Candidate Runtime promotion | `PENDING` | pending | Hidden candidate promotion after ready, editor-scene, and registry commit. |
| 3. Unchanged Stop cache/reuse | `PENDING` | pending | Reuse immutable build, validation, and asset artifacts. |

## Concentrated Self-Test

Pending until all three Slices are committed.

## Release Hardening

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Run at least five browser Play/Stop cycles and the 50-cycle real Snow soak,
  checking GPU/resource disposal and process memory.
- Exercise candidate timeout, cancellation, context loss, malformed scene
  evidence, registry persistence failure, and reconnect ownership changes.
- Revalidate Phase 3 authoritative Save against the M2 registry CAS before
  release.

## Manual Acceptance

1. Open a fresh project and record the committed Runtime identity and visible
   canvas pixels.
2. Inject a candidate startup failure during Stop; require the same committed
   identity and pixels plus a recoverable lifecycle state.
3. Run at least two unchanged Play/Stop cycles; require no blank frame and no
   increase in builder, validation, or asset-fetch counters.
4. Complete a normal Stop; require promotion only after matching ready,
   acceptable editor scene, and registry commit, then one active Runtime and
   zero candidates.
5. Inject a stale epoch event and run immediate Save; require no stale
   mutation, a clean saved revision, and `appProblems=[]`.

Failure is committed identity or pixels changing before registry commit,
candidate leakage after settlement, repeated immutable work, stale-event
mutation, an immediate-Save regression, or any app problem.

No push, amend, rebase, Phase 3/4 work, unrelated debug cleanup, user service
restart, or port 3080 access is authorized.
