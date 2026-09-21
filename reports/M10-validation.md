# M10 Validation

Status: **ACCEPTED (2026-09-18)**

## Execution checkpoint

EXECUTION_CHECKPOINT
- Updated at: 2026-09-18 22:57:40 +0800
- Milestone: M10 - WebGPU Compute and gameplay systems
- Slice: acceptance Fix F2 - raw WebGPU renderer ownership
- Phase: accepted
- Slice state: COMMITTED_LOCAL
- Completed facts: Uploaded Session `session-1372f69e-87d0-4457-aa68-4c1c8c412497` opened `GPU-Culled Flower Field` as project `example-25de29b62548dd13e2f7fb8e0fdf299d13e691f3d839a7455d18081f` at revision `a32765d7af4652448239f48fc1256386da2153d4550032f3b38d5972341e607f`. Import succeeded, then the shared M7 Runtime rejected the declared `raw-webgpu` backend before `setup()` with `raw-webgpu runtime is outside the M7 profile`. The user confirmed that F2 may supersede F1's temporary `No P7 architecture` exclusion, provided the fix remains one M7 Runtime with a renderer-self-managed compatibility branch. Commit `9de5dfd` permits that branch, resolves raw `fetch()` asset aliases, and supports native canvas writes without creating a second Runtime implementation. The user completed manual acceptance on 2026-09-18.
- Repository state: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`, branch `main`, HEAD `9de5dfd`. F2 committed only its owned hunks in `src/m7-runtime.ts` and `tests/m10-p7-raw-webgpu.mjs`; unrelated local edits remain unstaged.
- Intended changes: None. Preserve unrelated local edits while retaining commit `9de5dfd` and this acceptance record.
- Explicit exclusions: No second Runtime implementation, no changes to the external corpus or `dsh-uni-editor`, and no unrelated Runtime registry/debug work. No M11, Release Hardening, push, PR, rebase, amend, deploy, or historical evidence cleanup.
- Verification: `tests/m10-p7-raw-webgpu.mjs` PASS against the exact P7 corpus project: ready build `69d406ba...`, 1,843,288-byte bundle, 2 assets, Runtime backend `raw-webgpu`, frame `1`, no Three renderer, `1,048,576` candidates, browser-composited pixel sample lit `2400/2400` with `1185` colors, and Stop without `runtime-error`. Focused capability and asset-fetch tests PASS `4/4`; syntax and owned `git diff --check` PASS.
- Evidence paths: uploaded `/Users/bytedanceo/Downloads/dsh-session-session-1372f69e-87d0-4457-aa68-4c1c8c412497 (1)/session.jsonl`; regression `tests/m10-p7-raw-webgpu.mjs`; isolated candidate bundles `.tmp/m10-ash-candidate/{server,view}.js`. External corpus remains pinned to `98453747cc0678f6a5d910f38d7483596a5f9a40`.
- Run identity: P7 project `example-25de29b62548dd13e2f7fb8e0fdf299d13e691f3d839a7455d18081f`, revision `a32765d7af4652448239f48fc1256386da2153d4550032f3b38d5972341e607f`, build `69d406bacaa8150d4900cec7ebfea0d402d64c53b4cf7ff259123e8f11870988`. Isolated smoke Runtime was disposed after verification.
- Resource ownership: The M10 candidate DSH and Three.js MCP child were stopped after acceptance. Existing dirty files and the running `127.0.0.1:3080` DSH instance remain outside M10 lifecycle ownership.
- Active command: N/A.
- Continuity constraints: Preserve all baseline dirty hunks byte-for-byte; keep one M7 Runtime/coordinator/identity path and one sandbox canvas.
- Invalidators: HEAD or branch changes outside owned commits; concurrent edits to `src/m7-runtime.ts`; unknown staged files; external corpus revision drift; verification source/revision mismatch.
- Blockers and risks: No open-path blocker remains. Browser-composited pixels are verified, but `capture_runtime_frame` still relies on 2D readback of the WebGPU presentation canvas and is not claimed as P7 evidence; cross-platform raw-WebGPU coverage remains deferred to Release Hardening.
- Exact next action: Define the M11 evidence and release slices before implementation.
- Stop condition: M10 is closed; do not reopen it without new acceptance evidence.

## Smoke failure and repair ledger

| Evidence | Product failure | Root cause | Fix status |
| --- | --- | --- | --- |
| `/Users/bytedanceo/Downloads/session.jsonl 2` | `open_editor` returned “Opened” and the Agent declared Ash Growth loaded before the App Runtime settled. The later App failure was absent from the turn conclusion. | The tool result represented import/request acceptance, while App load was asynchronous. Failure updated only visible status; it neither replaced the old Runtime model context nor woke the Session. The project also required pinned Draco decoder files that were outside the imported corpus revision. | Tool result now says loading is pending. The builder injects hash-verified pinned decoder assets, resource reads bind them to the exact ready build, and App load failure publishes structured context plus one Session message. Focused browser regression PASS. |
| `.tmp/m10-self-test/browser.log` | G1 emitted `runtime-error` instead of `ready`: `THREE.GLTFLoader: Failed to load buffer "data:application/octet-stream;base64,..."`. | The generated JSON glTF used an embedded data-URI buffer. The sandbox CSP permits only `connect-src 'self'`, so GLTFLoader's secondary fetch was rejected. | Repaired by generating one self-contained binary `.glb`; build contract updated to parse the GLB JSON chunk and require `model/gltf-binary`. Validated by the final targeted G1 run. |
| `.tmp/m10-self-test/g1-browser-debug.log` | G1 emitted `runtime-error` instead of `ready`: `TypeError: Illegal invocation` in `setup`. | Assigning `canvas.tabIndex = 0` invoked a DOM property setter through the Runtime canvas proxy with an invalid receiver. | Repaired with proxy-safe `canvas.setAttribute("tabindex", "0")`. Validated by the final targeted G1 run. |
| `.tmp/m10-self-test/g1-browser-fixed.log` | Pause assertion observed additional movement between the pre-command sample and the paused frame. | The test sampled position before sending `timeScale=0`, allowing normal animation frames during command transit. | Repaired by sampling `pauseStart` after the `time-scale` acknowledgement, then comparing paused position to that anchor. |
| `.tmp/m10-self-test/g1-browser-fixed-2.log` | Browser-problem gate found two `GLTFLoader: Missing min/max properties for accessor POSITION` warnings. | The generated morph POSITION accessor omitted required bounds. | Repaired by adding deterministic `min`/`max`; final targeted G1 result records `browserProblems: []`. |
| `.tmp/m10-self-test/real-p6-r1-recording.log` | Real-provider P6 assertions and raw browser gate passed, but visual review found the final fire volume had not warmed up enough to be legible. | The real-model harness captured immediately after backend/resource readiness, while the accepted standalone P6 path waits for at least 60 Runtime frames. | R1 frames rejected for GIF use. Harness now requires `metrics.frame >= 60`; R2 uses fresh isolated roots and the same minimal non-mutating model flow. |

## Slice ledger

| Slice | Commit | Result |
| --- | --- | --- |
| S1 WebGPU lifecycle and capability | `ae9f272` | One M7 Runtime/coordinator path now owns typed capability checks and reverse-order, idempotent GPU resource disposal. |
| S2 P6 Volumetric Fluid Fire | `ac443ab` | Pinned external P6 profile, GLTF/Draco/KTX2, Bloom, emitters, editable compute parameters, debug modes, and explicit fluid/pipeline teardown. |
| S3 G1 gameplay fixture | `69ffcb6` | Owned binary GLB fixture with skin, animation, morph, third-person input, grounded physics, audio unlock, pause/resume, and restart cleanup. |
| Post-S3 repair | `3275849` | Binary GLB/CSP repair, proxy-safe focus, morph bounds, pause sampling, and focused browser harness. |
| Runtime evidence | `f6a2767` | Browser capability case and isolated real DSH Replay/App/Runtime proof. |
| Strict real-provider evidence | `2d8153c` | Unfiltered browser diagnostics, project-bound App lifecycle, real-provider G1/P6 Runtime recording, and endpoint diagnosis. |
| Candidate documentation | `d88f590` | M10 plan status and complete validation evidence moved to `MILESTONE_CANDIDATE / AWAITING_ACCEPTANCE`. |
| Acceptance Fix F1 | `fdaff58` | Ash Growth pinned decoder resources plus pending/success/failure open lifecycle feedback. |
| Acceptance Fix F2 | `9de5dfd` | Raw WebGPU renderer ownership, asset fetch resolution, canvas facade support, and focused P7 Runtime evidence. |

## Capability matrix

| Backend/environment | Expected behavior | Evidence | Result |
| --- | --- | --- | --- |
| WebGL, secure or insecure | Available; WebGPU capability does not gate WebGL | `tests/m10-runtime.test.mjs`, G1 result | PASS |
| WebGPU, secure, `navigator.gpu` present | Start `WebGPUBackend`; expose compute/storage metrics | P6 browser and DSH results | PASS |
| WebGPU, secure, API absent | Fatal `WEBGPU_UNAVAILABLE`, typed capability payload, no fallback | `.playwright-mcp/m10-capability-result.json` | PASS |
| WebGPU, insecure | Fatal `WEBGPU_INSECURE_CONTEXT` before renderer construction | `tests/m10-runtime.test.mjs` | PASS |
| WebGPU renderer initialization failure | Fatal `WEBGPU_INITIALIZATION_FAILED` with capability payload | generated Runtime contract assertion | PASS |
| Raw WebGPU P7 | C5 renderer-self-managed branch in the shared M7 Runtime | `tests/m10-p7-raw-webgpu.mjs` | PASS on macOS Chrome |

## Concentrated self-test

```text
pnpm run build
  PASS

THREEJS_EDITOR_MCP_WORKSPACE=... node --test \
  tests/m10-runtime.test.mjs \
  tests/m10-corpus-build.mjs \
  tests/m10-g1-build.mjs
  PASS 4/4
```

P6 browser evidence:

- revision `8113bcdac6f08d20de24e2f0a226398a924663945197316a3c90fc64c1e8f8ab`
- build `29d704ce486e7cda86a6d6bd7977ffef8a014fe10d35d2ab640b756ae26e04fa`
- `WebGPUBackend`, render grid `100x78x49`, physics grid `80x63x40`
- `pressureIterations=4`, `gpuResources=1`
- teardown `gpuResourcesDisposed=1`, `gpuResourcesAfterDispose=0`
- distinct restart run ID and `browserProblems: []`

G1 browser evidence:

- revision `71f1dc01e0c8e10df8cee493f6e118c8ef1e9d1236db722a00e2f954108abc01`
- build `335d1976a7f4a8587c050698da81c8e6f2140460409509292b8dcefe2357c3b8`
- skin present, one animation clip, one morph target
- keyboard movement changed negative Z; audio reached `running`
- zero time scale reported `paused=true`; resume cleared it
- restart reset position to `[0, 0, 0]`; `browserProblems: []`

## Real-model defect repair

R2 and R3 independently proved the normal configured provider could diagnose
and repair the injected G1 syntax defect through DSH tools. R3 is the retained
authoritative run:

- session `session-f2981e55-967c-4f28-aed7-2db4dbc5ba74`, one completed turn,
  54 steps, `openStep=null`, `pendingCalls={}`
- failed build `e2b5c055798a2590b4c151ce796d7780ca3cfbb176992a8bc4d0951283f4adc3`
- exact diagnostic `src/main.js:81:54: Unexpected ";"`
- one actual `mcp__threejs__apply_project_files` call
- ready build `b0e3469ff8a2ed3b4db67203adc9d37dcd544e6346d37b48d0d43877a2fea52d`
- final revision `71f1dc01e0c8e10df8cee493f6e118c8ef1e9d1236db722a00e2f954108abc01`
- repaired source SHA-256
  `a690c8b768a377f292a660bad9dc90653a8ab80accb549ffe8e1b5ced463facb`

The later G1 recording used the same source hash without another repair round.

## Real-provider Runtime evidence

| Case | Model/tool flow | Runtime evidence | Browser gate |
| --- | --- | --- | --- |
| G1 | Real provider; actual `open_editor` and `build_project`; no file mutation | project `workspace-5cb6cf1080e953efd5dbafc091c1a302d1ba54bf910fa3f244f755`; build `ac9939ed123654f23ae29329ff1bf40fe27bfddca1cbe92ce92911b0cff4a3c1`; skin, animation, morph, movement, audio unlock, skeleton debug | `browserProblems: []` |
| P6 | Real provider; actual `open_editor` and `build_project`; no file mutation | project `workspace-fa1f5567f56887ac77a1978449a6a5d7360da37d5c047eae887dff`; build `64f9a49f71df4fdf989ba1981d5f5998d7196faa25c48402ce5e5c3097015468`; `WebGPUBackend`, `gpuResources=1`, `pressureIterations=4`, frame-60 warm-up | `browserProblems: []` |

Both result files bind the captured Runtime to the model session, project,
workspace revision, and loaded build. Host logs contain only their isolated DSH
URLs. The process wrapper reported restricted Chrome/PNPM paths after each
result and cleanup; product assertions and cleanup had already completed.

## Accepted visual evidence

| Artifact | Storyboard | Encoded result | SHA-256 |
| --- | --- | --- | --- |
| `.playwright-mcp/m10-real/g1.gif` | running, moved/audio unlocked, skeleton debug | 1200x752, 75 frames, 7.5 s, 104,497 bytes | `1542820042167bfacfa7293e50199cb1a79ada4c214a22ee4fe1ac0effc83089` |
| `.playwright-mcp/m10-real/p6.gif` | warmed final fire, temperature, colliders | 1200x752, 75 frames, 7.5 s, 619,962 bytes | `442fd653a533ce9acd31b54683a09201fa80fe2b13643a11e6a5d035b93863da` |

Both storyboards were captured from separate isolated, real-provider DSH/App
Runtime runs. Representative frames decoded from each encoded GIF were visually
inspected for ordering, legibility, final hold, and absence of sensitive data.

## Rejected fixture defect repair

This fixture-only exercise is retained as diagnostic evidence but does not
satisfy the model-backed acceptance requirement. The G1 generator was changed
from:

```js
paused = state.paused || state.timeScale === 0
```

to `paused = false`. The real browser run failed at the pause contract with
`false !== true`; see `.tmp/m10-self-test/g1-deliberate-defect.log`. The correct
state/time-scale gate was restored and the identical run then passed pause,
resume, restart, and browser-problem assertions; see
`.tmp/m10-self-test/g1-deliberate-repair.log` and
`.playwright-mcp/m10-g1-repair-result.json`. The defective state was never
staged or committed.

## Rejected filtered DSH evidence

The isolated run at `.tmp/m10-dsh-runtime-final-r4` used deterministic
Replay through the DSH Agent loop, the linked unmodified `dsh-uni-editor`, and
the built MCP server. It is rejected because its harness filtered browser
errors:

- project `workspace-23f3bcf4e6442bde0b07569e98b521dd3db6f9ee784a888f125ea7`
- source revision `8113bcdac6f08d20de24e2f0a226398a924663945197316a3c90fc64c1e8f8ab`
- build `28d21b0fca25d03eaa66563dd0d7a7d20260d4230277ce5278962d59acfcf7b3`
- active Play run `a656682b-1a3f-4c72-9c9a-acd93eca1086`
- Stop replacement run `348c34fa-4c36-48af-97cd-fce5e8e71b66`
- deterministic evidence run `5072c5c2-d0df-477a-a99e-33d28aadfb58`
- capture digest `ec29ecebc4b418e56b7cc2121e39083577d0d17ee074e52207339ded8fe1cca1`
- source, loaded-build, and evidence revisions match
- `WebGPUBackend`, `gpuResources=1`, `pressureIterations=4`
- raw browser problems included two `ERR_CONNECTION_REFUSED` console errors

The filter has been removed. No future evidence may suppress these errors.

## Rejected fixture visual evidence

| Artifact | Storyboard | Encoded result |
| --- | --- | --- |
| `.playwright-mcp/m10/p6.gif` | final fire, temperature, colliders | 1200x750, 75 frames, 7.5 s, 323,915 bytes |
| `.playwright-mcp/m10/g1.gif` | running, moved/audio unlocked, skeleton | 1200x750, 75 frames, 7.5 s, 72,683 bytes |
| `.playwright-mcp/m10/dsh-p6.png` | real DSH fullscreen P6 Runtime | 1440x1000 PNG |

These older GIFs use Playwright fixture transport and remain diagnostic only.
They have been replaced by the accepted real-provider artifacts above. All
visual artifacts are ignored by Git.

## Dependency and distribution

P6 is pinned to external corpus commit
`98453747cc0678f6a5d910f38d7483596a5f9a40`, MIT licensed, and remains
external-only. Runtime code uses repository dependency `three@0.185.1`; Draco
and Basis/KTX2 decoder files come from the installed Three.js package and are
served as revision-bound Runtime assets. No external decoder network request is
required, and no P6 corpus asset enters the published package.

## Release Hardening deferred

The full suite, full TypeScript check, lint/check aggregate, packed-install
verification, cumulative review, cross-platform raw-WebGPU coverage, raw
presentation-surface Harness capture, push, PR, and release remain deferred
until explicit Release Hardening authorization.

## Human acceptance

1. Open P6 and verify final, temperature, and collider views are visibly distinct.
2. Stop and restart P6; verify the new run renders and no stale GPU resource remains.
3. Open G1, click the canvas to unlock audio, move with `W`, pause/resume, and select skeleton debug.
4. Restart G1 and verify the player returns to the origin.
5. Inspect the capability matrix and confirm unavailable WebGPU produces a typed fatal error rather than a black screen or WebGL fallback.
6. Open P7 GPU-Culled Flower Field and verify the raw WebGPU field renders and Stop completes.

Any missing P6/G1 behavior, identity mismatch, nonzero GPU resources after P6
dispose, raw browser warning/error, untyped capability failure, fixture-only
repair, or fixture-only GIF rejects M10.
