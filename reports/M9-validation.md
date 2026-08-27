# M9 Validation

Status: **MILESTONE_SELF_TEST - BLOCKED**

Baseline: `ca0c8cb385f5e0e5fd5765eb62809037763512c0`

Local commits:

- `84df614 test: stabilize M9 replay workspace setup`
- `39fa32a feat: add M9 advanced pipeline validation`
- `1015cae test: reveal reused workspace session action`

No push, merge request, release, full test suite, full typecheck, or independent
review was performed.

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

The exact DSH Replay command used the existing isolated run root:

```text
THREEJS_EDITOR_MCP_WORKSPACE=.../dev/example-gallery/examples
M9_RUN_ROOT=/var/folders/s2/25w91rj147zd7j5yw736d3bc0000gq/T/threejs-m9-ui.mVoSrL
M9_SKIP_PROVISION=1
M9_START_TIMEOUT=60000
pnpm run test:e2e:m9-ui
```

Observed results:

1. The first post-S1 run exited in about 78 seconds. It proved the configured
   workspace action existed only as a hidden hover action. Commit `1015cae`
   fixed that harness path.
2. The follow-up run reached navigation at `+22.073s`, submitted the replay
   prompt at `+64.142s`, and began waiting for the App frame at `+66.276s`.
3. Replay emitted `mcp__threejs__open_editor`; the tool result completed in
   7.579 seconds with project
   `example-ca7d3a00de72f03730e2a890e9985bcdcc5249908479704a8b45d212` and revision
   `9e13cb7addcadb89ecec8c8e63ad7e6befa61e734401e9e123334fdcd11042c4`.
4. The UI created an iframe titled `MCP App: mcp__threejs__open_editor`, but its
   host remained `data-mcp-app-status="loading"` with an empty `src`.
   `/api/mcp-apps/view` remained pending until cleanup.
5. The 60-second App-frame budget expired at `+131.386s`. The harness cleaned
   its own DSH/browser processes and preserved the run root and trace.

The final run exceeded the requested 120-second command wall bound because
startup and navigation consumed about 64 seconds before the bounded iframe
wait. No further UI retries were started.

Because the App never became ready, this run did not exercise the quality save,
Agent edit, build/run identity, evidence capture, or context-loss restart.
`reports/M9-ui-stage.log` contains the final command output. The current trace
is at the run root above.

## Release Hardening Deferred

These checks are deferred until explicit approval for Release Hardening:

| Check | Risk covered | Deferred reason | Command or scope |
|---|---|---|---|
| Full unit/integration suite | Cross-milestone regressions from asset and runtime changes | Development-phase scope | `pnpm test` |
| Full TypeScript check | Uncovered type interactions | Development-phase scope | `pnpm run typecheck` |
| Production rebuild and package check | Stale `dist` or package omissions | Development-phase scope | `pnpm run build && pnpm run test:pack` |
| Full repository gate | Upstream sync plus all tests | Development-phase scope | `pnpm run check` |
| Independent code review | Correctness, security, and maintainability across cumulative diff | Requires separate Reviewer | Review `ca0c8cb..HEAD` |
| Real DSH UI revalidation | MCP App `/view` loading and complete acceptance path | Current blocking defect | `pnpm run test:e2e:m9-ui` with a fresh bounded profile |

## Human Acceptance

After the App loading blocker is fixed:

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
signalled. No files in `deepseek-harness` or `dsh-uni-editor` were modified.

Primary residual risk: the DSH MCP App host creates the outer iframe but does
not complete `/api/mcp-apps/view` within the bounded smoke, so the full
acceptance chain remains unverified. M9 is not an acceptance candidate and M10
must not start.
