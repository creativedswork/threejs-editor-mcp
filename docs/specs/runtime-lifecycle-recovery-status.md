# Runtime Lifecycle Recovery Status

Updated: 2026-08-30
Milestone: M0 Characterization
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`

## Slice Ledger

| Slice | State | Commit | Result |
|---|---|---|---|
| 1. Lifecycle-idle observability | `COMMITTED_LOCAL` | `a5f65cc` | `__THREE_M7__.metrics().m7.lifecyclePending` distinguishes the early `editing` projection from settled Runtime lifecycle work. |
| 2. Immediate Save race characterization | `COMMITTED_LOCAL` | `0c706d0` | The M7 browser harness delays the Stop restoration model-context response, mutates `VF-26`, and starts Save while `editing` and `lifecyclePending` overlap. |
| 3. Initial Runtime readiness closeout | `COMMITTED_LOCAL` | This commit | Initial open skips duplicate hidden validation; replacement validation remains intact, and the fresh-profile race smoke passes. |

## Slice 1

- The observable is read-only and reuses the existing Runtime start controller
  and tracked lifecycle-task set.
- Play, Stop, Save, Runtime startup, and cleanup behavior are unchanged.
- The focused characterization records that `editing` is projected before
  model-context publication settles and that tests can observe pending work.
- The open `play-stop-restore-failure` debug session and all existing probes,
  logs, and support files remain untouched.

## Slice 2

- `tests/m7-browser.mjs` reuses the deterministic Formula One Runtime fixture:
  375,964 unique triangles on WebGPU, with no copied Snow assets or new
  heavyweight fixture.
- The host receives the next `/api/mcp-apps/model-context` request during Stop
  restoration, but Playwright withholds its HTTP response.
- The test requires `playState: editing` and `lifecyclePending: true`, changes
  `VF-26` Position X to `0.35`, and clicks Save during that overlap.
- The encoded current-behavior outcome is Save entering `sync: saving`, then,
  after the delayed response is released, settling as clean editing state with
  a changed revision, the same Runtime run ID, Position X `0.35`, and
  `lifecyclePending: false`.
- Slice 2 did not change production behavior.

## Slice 3

- Initial open has no committed Runtime to protect, so `startM7Runtime()` skips
  hidden validation when `m7ActiveRun` is absent.
- Runtime replacement still validates the candidate bundle before stopping the
  active Runtime. Candidate/Committed Runtime semantics remain deferred to M1.
- The browser harness uses the official Workspace creation endpoint, waits for
  replay settlement and persisted disclaimer acknowledgement, allows the
  measured 300-second replacement window, and triggers the race from the App
  frame after the replacement `editor-scene` event.

## Concentrated Self-Test

- `node --check tests/m7-browser.mjs` passed.
- `git diff --check -- tests/m7-browser.mjs` passed.
- `node --test tests/m7-pointer-interaction.test.mjs` passed: 13 tests.
- `pnpm run build` passed in the clean detached candidate worktree.
- The final fresh-profile browser smoke completed in 15m54s with empty stderr.
- `immediateSaveRace` observed editing and saving while lifecycle work was
  pending, then clean editing with a changed revision, Position X `0.35`, and
  no pending lifecycle work.
- `appProblems` was empty and the Workspace contained the third committed
  transaction.
- Full suite, repository build, typecheck, lint, coverage, and independent
  review were not run.

## Release Hardening

- Run the focused M7 race smoke from a freshly provisioned DSH profile and
  fresh Workspace/project roots; require the emitted `immediateSaveRace`
  evidence to match every encoded assertion.
- Run the real Snow Accumulation smoke with its GLB, five dynamic asphalt
  textures, KTX2 setup, and post-processing. The Formula One fixture is heavy
  but is not Snow-equivalent.
- Run five Play/Stop/immediate-Save cycles in browser CI and at least 50 Snow
  Play/Stop/Save cycles in the release soak.
- Cover model-context timeout and rejection, diagnostics failure, missing scene
  report, candidate startup failure, Runtime context loss, and external
  revision arrival during Play, Stop, and Save.
- Assert one active Runtime, converged Workspace/registry/iframe revisions,
  nonblank pixels, disposed old resources, restored controls, and no unhandled
  rejection or listener warning after every cycle.
- Run the full Node/browser suites, typecheck, lint, production build, package
  checks, and an independent cumulative code review on the final candidate.

## Acceptance

Target:

- M0 must expose and deterministically schedule the premature-editing Save
  overlap without changing Play, Stop, Save, or Runtime production behavior.

Steps:

1. Provision a fresh DSH Web profile with `dsh-uni-editor` and the M7 replay
   patches.
2. Run `tests/m7-browser.mjs` against fresh Formula One Workspace/project
   roots.
3. Inspect `immediateSaveRace` in stdout.

Expected evidence:

- `editingWhileLifecyclePending` is `{ playState: "editing",
  lifecyclePending: true }`.
- Save starts with `sync: "saving"` while `lifecyclePending` remains true.
- The final state is clean editing, the revision changed, Position X is
  `0.35`, and `lifecyclePending` is false.

Failure:

- The overlap cannot be observed, Save cannot start, Save settles in error or
  remains saving, the revision/transform is lost, or lifecycle work does not
  settle.

## Scope And Risk

- M0 changes observability, browser characterization, and only the
  evidence-backed initial-open validation guard.
- M1 lifecycle-controller work has not started.
- All pre-existing dirty production changes and debug artifacts remain
  excluded from the closeout commit.
- No push or other remote operation was performed.
- The debug session remains open and all evidence is retained pending user
  acceptance.

M0 remains a candidate until the user accepts this evidence. M1 has not
started.
