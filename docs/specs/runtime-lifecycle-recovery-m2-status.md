# Runtime Lifecycle Recovery M2 Status

Updated: 2026-08-31
Milestone: M2 Atomic Stop replacement
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`
Base: `90a5613`
Candidate implementation: `1936345`

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
| 1. Registry prepare/commit | `COMMITTED_LOCAL` | `42c2d4c` | Owner-scoped prepared run with short expiry and active-run CAS; failed or stale commits leave active unchanged. |
| 2. Candidate Runtime promotion | `COMMITTED_LOCAL` | `2723719` | Hidden candidate promotion after ready, editor-scene, and registry commit; every pre-commit exit disposes only the candidate. |
| 3. Unchanged Stop cache/reuse | `COMMITTED_LOCAL` | `b99907b` | Reuses immutable build output, validation, and asset blobs by project and revision identity. |

## Fix Ledger

| Fix | Commit | Evidence |
|---|---|---|
| Cover the legal candidate transition window with a bounded prepared lease. | `1b3520a` | View requests 310 seconds; server validates and caps leases at 600 seconds; short expiry remains covered by the registry test. |
| Dispatch browser-smoke controls within the App iframe so host overlays cannot intercept them. | `d0743d3`, `68f36a8`, `1936345` | Livery, Play, Stop, and Save use the real App controls and lifecycle/metrics assertions remain authoritative. |

## Concentrated Self-Test

- `pnpm run build`: passed.
- `node --test tests/runtime-lifecycle.test.mjs tests/runtime-effects.test.mjs tests/m7-pointer-interaction.test.mjs`:
  22 passed, 0 failed in 0.60 seconds.
- `node --test tests/runtime-registry.test.mjs`: 1 passed, 0 failed in
  5.74 seconds. This covers prepared expiry, excessive TTL rejection,
  stale-active CAS rejection, unchanged active identity after failed commit,
  and successful promotion.
- The controller test `rejects stale epochs without replacing the committed
  Runtime` directly asserts that a rejected candidate result cannot replace
  the committed Runtime. Deadline failure also settles as recoverable and
  leaves the queue reusable.
- Isolated browser smoke passed against a fresh workspace/project on random
  port 65533 using evidence root
  `/private/tmp/threejs-m2-smoke-final.qIRP83`.
  - Both unchanged-revision Stop cycles kept `minActive=1` and
    `minVisible=1` throughout candidate preparation, then settled at one
    active Runtime and zero candidates.
  - Build, asset-fetch, and validation counters remained
    `3 / 0 / 2` across both unchanged Stop cycles.
  - Immediate and repeated post-promotion pixel samples were non-empty; both
    Runtime screenshots show the rendered Formula One scene.
  - Immediate Save completed with a changed revision, clean sync state, and
    `appProblems=[]`.
- Browser smoke duration was about 10 minutes. M2 implementation, focused
  fixes, and concentrated verification took about 2 hours 15 minutes of
  wall-clock development time.

The diagnostic session `hidden-candidate-ready-timeout` remains `[OPEN]` with
its probes, collector, and evidence retained until milestone acceptance.
Hypotheses A-H were rejected; the focused run did not support an additional
product change.

## Release Hardening

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Run at least five browser Play/Stop cycles and the 50-cycle real Snow soak,
  checking GPU/resource disposal and process memory.
- Exercise candidate timeout, cancellation, context loss, malformed scene
  evidence, registry persistence failure, and reconnect ownership changes.
- Revalidate Phase 3 authoritative Save against the M2 registry CAS before
  release.
- Remove the retained `hidden-candidate-ready-timeout` instrumentation only
  after explicit milestone acceptance.

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

## Non-Goals

- Phase 3 authoritative Save and Phase 4 legacy-state removal.
- Full-suite, lint, coverage, release-check, packaging, deployment, or push.
- Cleanup of unrelated debug sessions, probes, reports, or user changes.

No push, amend, rebase, Phase 3/4 work, unrelated debug cleanup, user service
restart, or port 3080 access is authorized.
