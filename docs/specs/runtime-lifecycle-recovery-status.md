# Runtime Lifecycle Recovery Status

Updated: 2026-08-28
Milestone: M0 Characterization
State: `MILESTONE_CANDIDATE`
Gate: `AWAITING_ACCEPTANCE`

## Slice Ledger

| Slice | State | Commit | Result |
|---|---|---|---|
| 1. Lifecycle-idle observability | `COMMITTED_LOCAL` | `a5f65cc` | `__THREE_M7__.metrics().m7.lifecyclePending` distinguishes the early `editing` projection from settled Runtime lifecycle work. |
| 2. Immediate Save race characterization | `COMMITTED_LOCAL` | This commit | The M7 browser harness delays the Stop restoration model-context response, mutates `VF-26`, and starts Save while `editing` and `lifecyclePending` overlap. |

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
- No production file is changed by Slice 2. In particular, `src/view.ts`
  remains untouched.

## Concentrated Self-Test

- `node --check tests/m7-browser.mjs` passed.
- `git diff --check -- tests/m7-browser.mjs` passed.
- `node --test tests/m7-pointer-interaction.test.mjs` passed: 13 tests.
- The focused browser smoke required an isolated build because the checked-in
  `dist/view.js` predates Slice 1. `pnpm run build` passed in a detached
  `a5f65cc` worktree and did not alter the dirty checkout.
- Browser confirmation is blocked before the new race assertions. The first
  attempt used a fresh DSH profile without the local `dsh-uni-editor` bundle
  and rendered an unknown-tool result. After provisioning the bundle, the
  bounded rerun reused the profile and the existing workspace-picker fallback
  waited for a nonexistent Continue control. No race assertion failed; neither
  attempt reached the race.
- Per the user stop instruction, no further browser command was started.
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

- M0 changes only observability and browser characterization.
- M1 lifecycle-controller work has not started.
- All pre-existing dirty production changes and debug artifacts remain
  excluded from the Slice 2 commit.
- No push or other remote operation was performed.
- Residual blocker: the focused browser race still needs a successful fresh
  profile run before M0 acceptance.

Implementation and concentrated self-test were the same order of magnitude;
environment provisioning and the two blocked browser attempts dominated
self-test time, so validation was stopped rather than expanded.
