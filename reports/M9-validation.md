# M9 Validation

Status: **ACCEPTED**

Acceptance decision: the user stated “好M9验收通过，进入M10” on 2026-09-05.
M9 is accepted and M10 is authorized; this documentation closure does not start
M10.

Baseline: `ca0c8cb385f5e0e5fd5765eb62809037763512c0`

Local commits:

- `84df614 test: stabilize M9 replay workspace setup`
- `39fa32a feat: add M9 advanced pipeline validation`
- `1015cae test: reveal reused workspace session action`

No push, merge request, release, full test suite, full typecheck, or independent
review was performed.

## Execution Checkpoint

EXECUTION_CHECKPOINT
- Updated at: 2026-09-05 02:35:01 +0800
- Milestone: M9
- Slice: post-R1-R5 compatibility and concentrated self-test
- Phase: accepted
- Slice state: COMMITTED_LOCAL
- Completed facts: M9 S1/S2 remain committed as `84df614`, `39fa32a`, and `1015cae`; the App history-reload fix is committed as `d1562a7`; R0-R5 are accepted at `2b97755`; Replay identity compatibility is committed as `be649c7`; resource lifecycle compatibility is committed as `a1d0f78`; post-reload composer reacquisition is committed as `ad18b24`; native Chat-view restoration and the corrected resumed-composer DOM selector are committed as `dddb683`; current source-tail Replay capture compatibility is committed as `73cb69c`; frame reacquisition before Play is committed as `5e77f35`; the trace- and component-proven `Locate Editor` path is committed as `05adb52`; second-turn settlement before App return is committed as `d1cce3d`; onboarding dialog synchronization is committed as `62eae24`; native fullscreen foregrounding before Play is committed as `ab32e8a`; stable fullscreen frame-host identity is committed in `dsh-uni-editor` as `c86501d`; owner-bound Runtime evidence calls are committed as `0669a78`; synchronous post-commit surface placement is committed in `dsh-uni-editor` as `81c8cc2`; target-bearing Runtime evidence settlement is committed as `02bf29d`; fatal Runtime cleanup now preserves the coordinator's recoverable-failure state in `0789437`; recoverable-failure now exposes the existing Play restart transition in `e86c098`; the collector-backed final Replay passed every assertion with `browserProblems: []`.
- Repository state: `threejs-editor-mcp` `main` and detached candidate checkout are both at exact `e86c098cb9d0317d050e31001118a585f5bb8e1e`, index empty, with the previously classified mixed tracked and untracked changes preserved only in the main worktree and candidate `node_modules` preserved; `dsh-uni-editor` `main` at `81c8cc2`, index empty, with unrelated untracked `docs/promotion/`, `reference-pack/`, and `tests/reference-pack.test.mjs` preserved. Minimal owned Slice list: (1) `be649c7`, Replay opaque `runtimeRef` and nested evidence identity; (2) `a1d0f78`, resource-test migration to prepare/commit Runtime lifecycle; (3) `ad18b24`, post-reload existing-session composer reacquisition; (4) `dddb683`, restore the existing session through the visible `对话` tab and match its real textarea placeholder; (5) `73cb69c`, update the fixture source-tail capture for the current Clouds source; (6) `5e77f35`, reacquire the unparked current App frame before Play; (7) `05adb52`, return through the current project's native `Locate Editor` button after Agent build; (8) `d1cce3d`, wait for the second Replay turn to settle before App return; (9) `62eae24`, synchronize the native onboarding and workspace-picker dialogs; (10) `ab32e8a`, foreground the active App through its native fullscreen header action before Play; (11) `dsh-uni-editor:c86501d`, preserve the persistent frame-host DOM identity across inline/fullscreen reconciliation; (12) `0669a78`, use the owner session and catalog connection generation for App-visible evidence calls while sourcing `runtimeRef` from the current committed UI coordinator state; (13) `dsh-uni-editor:81c8cc2`, synchronously rebind and place the persistent iframe after a surface-mode React commit; (14) `02bf29d`, construct one target-bearing Runtime identity and reuse it for command start and typed evidence settlement; (15) `0789437`, settle fatal Runtime teardown as recoverable-failure without duplicating the original diagnostic; (16) `e86c098`, allow only Play to restart a committed aggregate from recoverable-failure while mutation controls remain disabled.
- Intended changes: no production or harness change remains pending; only this checkpoint and the master-plan status are being closed after user acceptance.
- Explicit exclusions: unrelated unstaged `src/view.ts` and `tests/m81-continuity.test.mjs` hunks; `src/server.ts` stdio/tuple changes; unrelated `src/m7-runtime.ts` scheduling work; M7/M8 tests; continuity and lifecycle documents; existing M9 debug instrumentation; `.dbg/`; debug notes; historical logs; uncertain fixtures; existing report assets; all remote operations.
- Verification: exact candidate typecheck PASS; prior production build PASS; focused resources PASS `2/2`; pinned P4/P5 corpus build PASS `2/2`; `dsh-uni-editor c86501d` focused registry/placement tests PASS `12/12`, typecheck PASS, and build PASS; `dsh-uni-editor 81c8cc2` build PASS. For `02bf29d`, the targeted source regression PASS `1/1` and candidate production build PASS. For `0789437`, the focused recoverable-failure regression PASS `1/1` and candidate production build PASS. For `e86c098`, focused lifecycle/UI regressions PASS `2/2` and candidate production build PASS. Final Replay root `.tmp/m9-replay-e86c098-final-r2` reported `all assertions passed`: reload/session continuity, quality `performance` save, Agent Clouds edit/build, fullscreen real Play, deterministic capture, source/build/run/evidence identity equality, recoverable WebGL context loss, distinct-run restart, and `browserProblems: []`. The outer TRAE sandbox wrapper returned `1` only after the test completed because it rejected Chrome Crashpad/Updater and temporary PNPM file access; the test result JSON, screenshot, traces, cleanup stage, and assertion output were already complete.
- Evidence paths: final result `.tmp/m9-replay-e86c098-final-r2/M9-ui-result.json`; visible Clouds screenshot `.tmp/m9-replay-e86c098-final-r2/m9-p5-ui.png`; traces `.tmp/m9-replay-e86c098-final-r2/M9-ui-trace.zip` and `.tmp/m9-replay-e86c098-final-r2/trace.zip`; host log `.tmp/m9-replay-e86c098-final-r2/host.log`; terminal log `.tmp/m9-self-test-be649c7/ui-rerun-e86c098-final-r2-terminal.log`; invalid onboarding evidence `.tmp/m9-replay-e86c098-final/trace.zip`; retained P4/P5 JSON and PNG evidence under `reports/`.
- Run identity: final Replay used exact `threejs-editor-mcp e86c098cb9d0317d050e31001118a585f5bb8e1e`, linked `dsh-uni-editor 81c8cc2`, root `.tmp/m9-replay-e86c098-final-r2`, URL `http://127.0.0.1:60625`, project `example-ca7d3a00de72f03730e2a890e9985bcdcc5249908479704a8b45d212`, source/build/evidence revision `65d0c1e3d438268e253c819a7ebc4cf69f4db6e4ac353b31f6866d0bcbaeb38d`, build `6c67170628da5272f959d931543057377cedbb3e43a5704e6e14094d665aa161`, active run `cfd09e43-9cf1-42e3-bbbb-77754e46f8e8`, validation evidence run `2edddf89-d5d0-4cd8-a1b1-a13f346d7f1a`, and recovery run `1d5fa8c9-6314-4eb7-9704-768456a74c0f`. All isolated Replay processes exited after cleanup. TRAE debugger session `play-stop-restore-failure` remains healthy on exact `127.0.0.1:7777`, collector PID `51754`, through user acceptance.
- Continuity constraints: preserve all excluded dirty hunks; use exact non-interactive staging; run the final Replay from an isolated profile and monitor both captured host logs and terminal stderr; source, build, run, and evidence must identify one candidate revision.
- Invalidators: branch or HEAD change, unknown staged content, target-file hash drift, reuse of a historical run as new evidence, source/build mismatch, browser refresh during the acceptance chain, or any unplanned process termination.
- Blockers and risks: no M9 acceptance blocker remains. Full-suite, full-typecheck, package, cumulative review, and release checks remain deferred to Release Hardening. Unproven asset, transport, lifecycle, and debug hunks remain excluded.
- Exact next action: M10 is authorized and may begin under a new Milestone Owner; this M9 closure does not start M10, M11, Release Hardening, or any remote operation.
- Stop condition: complete the M9 documentation-only acceptance commit with all excluded dirty content preserved and unstaged.

## Implemented Scope

- Pinned M9 dependency profile for `postprocessing`, `three-stdlib`,
  `astronomy-engine`, and `@petamoriken/float16`.
- Configurable Workspace quotas and revision-bound binary resources.
- Large assets stay outside tool text and transfer in 256 KiB chunks. Immutable
  objects are SHA-256 verified and read through a bounded cache.
- Chinese quality selector ordered `均衡`, `流畅`, `精细`, with `balanced` as
  the default. Saving writes `threejs.editor.json`, advances the revision, and
  starts a fresh edit Runtime from the new revision and build.
- Runtime registration and evidence bind to a server-verified ready `buildId`.
- Deterministic capture restores `timeScale`, capture pause state, and RAF
  scheduling in `finally`.
- `no-post` uses the direct renderer path. WebGL context loss stops rendering,
  emits a fatal recoverable diagnostic, and permits a fresh Runtime start.
- The M9 Replay harness supports fresh and reused DSH profiles without
  re-registering an existing workspace.

## Existing Functional Evidence

The pre-commit focused verification recorded:

```text
pnpm run typecheck
pnpm run build
node --test tests/m9-resources.test.mjs
  2/2 PASS
node --test tests/m7-builder.test.mjs tests/m81-continuity.test.mjs
  22/22 PASS
THREEJS_EDITOR_MCP_WORKSPACE=.../dev/example-gallery/examples pnpm run test:corpus:m9
  2/2 PASS
git diff --check
```

The standalone browser evidence in `reports/M9-browser-result.json` records:

- P4 IFFT error `1.6e-7`, resolution `256² × 3`, and deterministic digest
  `94e5270375c61878b2649f86c5cca3ffd4b7713be293608fa74acd1bdab01d6b`.
- P4 `normals`, `jacobian`, and three spectrum modes in the contact sheet.
- P5 transferred `7,915,297` bytes in `31` verified chunks.
- P5 detected EffectComposer, the 3D texture loader, three binary volume
  assets, 41 GPU textures, temporal upscale, and native mode.
- P5 `no-post` used `direct-renderer`; sampled pixels differed from the
  post-processed frame by 39.62%, with mean absolute channel difference 19.38.
- Context loss emitted `webgl-context-lost`, marked `recoverable: true`,
  stopped frame progression, and a distinct run restarted on the same build.
- The combined browser run recorded no console warnings or errors.

The committed P4/P5 JSON results and twelve PNG artifacts were not modified by
the failed Replay attempts and remain the current standalone evidence.

## Concentrated Self-Test

The final DSH Replay used a fresh isolated root and the exact collector-backed
environment:

```text
threejs-editor-mcp=e86c098cb9d0317d050e31001118a585f5bb8e1e
dsh-uni-editor=81c8cc274dca1d6b7ada9900f16fa833f3b4f412
THREEJS_EDITOR_MCP_WORKSPACE=.../Threejs-Awesome-Graphics-Agent-Skills/dev/example-gallery/examples
M9_RUN_ROOT=.tmp/m9-replay-e86c098-final-r2
M9_START_TIMEOUT=60000
DEBUG_SERVER_URL=http://127.0.0.1:7777/event
pnpm run test:e2e:m9-ui
```

Observed results:

1. DSH navigation, open-editor Replay, session reload, and persistent App frame
   restore completed.
2. Saving `流畅` produced revision
   `6e9b3c2774e978c4a9a5b1ee30f297654e7de89c9e258c746b5a276ab07a59fc`
   and the final Runtime reported `qualityTier=performance`.
3. The Agent changed Clouds coverage and built revision
   `65d0c1e3d438268e253c819a7ebc4cf69f4db6e4ac353b31f6866d0bcbaeb38d`
   as build `6c67170628da5272f959d931543057377cedbb3e43a5704e6e14094d665aa161`.
4. Fullscreen Play succeeded. Deterministic validation capture produced digest
   `17747a0976977c4d4afa8e2a7156512728014dacdf9ba7de59cf2a642b7f9d72`;
   workspace, loaded-build, and source revisions were equal.
5. WebGL context loss produced `state=error`, stopped the old Runtime, emitted
   the recoverable diagnostic, and restarted as distinct run
   `1d5fa8c9-6314-4eb7-9704-768456a74c0f` on the same build.
6. The harness reported `all assertions passed` and `browserProblems: []`, then
   cleaned all isolated processes. The final screenshot visibly contains the
   expected Weather Volume Clouds scene.

The M9 implementation and compatibility fixes took multiple development
sessions. The final concentrated smoke took about seven minutes; focused
resource, lifecycle, build, and UI checks remained smaller than the cumulative
implementation effort.

## Release Hardening Deferred

These checks are deferred until explicit approval for Release Hardening:

| Check | Risk covered | Deferred reason | Command or scope |
|---|---|---|---|
| Full unit/integration suite | Cross-milestone regressions from asset and runtime changes | Development-phase scope | `pnpm test` |
| Full TypeScript check | Uncovered type interactions | Development-phase scope | `pnpm run typecheck` |
| Production rebuild and package check | Stale `dist` or package omissions | Development-phase scope | `pnpm run build && pnpm run test:pack` |
| Full repository gate | Upstream sync plus all tests | Development-phase scope | `pnpm run check` |
| Independent code review | Correctness, security, and maintainability across cumulative diff | Requires separate Reviewer | Review `ca0c8cb..HEAD` |

## Human Acceptance

1. Confirm quality options are `均衡`, `流畅`, `精细`.
2. Select `流畅` and verify the saved Workspace revision changes and the edit
   Runtime reports that revision with `qualityTier=performance`.
3. Ask the Agent to set cloud coverage to `0.46` and build.
4. Verify source revision, build revision, active run revision, `buildId`,
   `runId`, and captured evidence identity match.
5. Induce WebGL context loss; verify a recoverable diagnostic, stopped Runtime,
   and a successful restart with a distinct `runId`.
6. Inspect the P4/P5 contact sheets for meaningful debug and pipeline variants.

Failure of any identity equality, quality persistence, recoverable diagnostic,
restart, or visual distinction keeps M9 blocked.

## Exclusions And Residual Risk

Excluded from every commit:

- `.dbg/`
- `debug-halo-selection-miss.md`
- `tests/fixtures/m6/workspace/.threejs-editor/`
- `tests/fixtures/m6/workspace/ideaops-m35-validation.md`

Historical PIDs `49675` and `68390` were observed unchanged and were not
signalled. No files in `deepseek-harness` were modified. The only
`dsh-uni-editor` M9 commits are `c86501d` and `81c8cc2`.

Residual risk is limited to checks explicitly deferred to Release Hardening.
The TRAE collector PID `51754` remains running and was not stopped during this
closure. M9 is accepted; M10 is authorized but was not started by this
documentation closure.
