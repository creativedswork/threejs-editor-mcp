# M10 Validation

Status: `IMPLEMENTING_SLICES`

## Execution checkpoint

EXECUTION_CHECKPOINT
- Updated at: 2026-09-05
- Milestone: M10 - WebGPU Compute and gameplay systems
- Slice: all Slices
- Phase: concentrated-self-test
- Slice state: COMMITTED_LOCAL
- Completed facts: User authorized M10 from accepted baseline `db75717`. S1 committed as `ae9f272`; S2 committed as `ac443ab`; S3 committed as `69ffcb6`. No M10 browser process is live. The post-S3 corrections are validated locally and remain uncommitted for a separate atomic Fix commit.
- Repository state: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`, branch `main`, HEAD `69ffcb6`, no staged files. Pre-existing tracked modifications: `docs/specs/editor-continuity.md`, `reports/M9-ui-stage.log`, `src/builder.ts`, `src/m7-runtime.ts`, `src/server.ts`, `src/view.ts`, `src/workspaces.ts`, `tests/m7-browser.mjs`, `tests/m7-builder.test.mjs`, `tests/m7-pointer-interaction.test.mjs`, `tests/m81-browser.mjs`, `tests/m81-continuity.test.mjs`, `tests/m9-ui-browser.mjs`. Pre-existing untracked content is classified as debug evidence under `.dbg/` and `debug-*.md`, runtime architecture/lifecycle reports and specs, generated M6 fixture workspace content, and harness-tool-call tests.
- Intended changes: The separate post-S3 Fix commit owns the focused M10 browser harness, binary GLB generation, proxy-safe canvas focus setup, morph accessor bounds, pause sampling correction, P6 contract correction, package script entry, and this report. Generated workspaces and visual evidence remain under ignored paths.
- Explicit exclusions: Preserve every pre-existing tracked and untracked file listed above; do not stage or commit them. Do not modify `dsh-uni-editor` without a proven shared-contract requirement. Do not kill collector PID `51754` at `127.0.0.1:7777`. No M11, Release Hardening, push, PR, rebase, amend, deploy, historical evidence cleanup, or P7 architecture.
- Verification: S1 `node --test tests/m10-runtime.test.mjs` PASS `2/2`. P6 build PASS with build ID `73b70c4a1b5f0d582d0b222ad18d8a22754f9caed98660351dabcf9158695a4f`. Final targeted G1 browser run PASS with `browserProblems: []`, build ID `760581e672a6bf50714cb85aaf833e8c0341a332e45e822f2d7b5b1e43fb600a`, and distinct run IDs `cbb99e1c-a686-4f2d-805e-c7eafa9bd095` / `52d23822-376f-47cb-a349-2231adfd1146`.
- Evidence paths: `reports/M10-validation.md`, `.tmp/m10-self-test/browser.log`, `.tmp/m10-self-test/g1-browser-debug.log`, `.tmp/m10-self-test/g1-browser-final.log`, `.playwright-mcp/m10-g1-result.json`, `.playwright-mcp/m10/g1/`
- Run identity: Final targeted G1 run IDs `cbb99e1c-a686-4f2d-805e-c7eafa9bd095` and `52d23822-376f-47cb-a349-2231adfd1146`; no M10 browser process is live.
- Resource ownership: This M10 Owner exclusively owns writes to the checkout, Git index, this STATUS, and future M10 ports/browser/Runtime. Existing collector PID `51754` on `127.0.0.1:7777` is externally owned and excluded.
- Active command: N/A; both failed smoke processes and the final targeted G1 process exited.
- Continuity constraints: Preserve baseline dirty files byte-for-byte and keep the index limited to explicitly owned M10 files. Reuse the single M7 Runtime/coordinator/identity path.
- Invalidators: HEAD or branch changes outside owned commits; any pre-existing dirty file changes because of M10 work; unknown staged files; collector PID `51754` termination; Runtime source or service restart during evidence capture.
- Blockers and risks: No current blocker. Chrome's wrapper can report platform Crashpad/RLZ access failures after the product assertions complete, so product result JSON, browser problems, host logs, and terminal stderr are evaluated independently.
- Exact next action: Exact-stage the owned post-S3 corrections and browser harness, create a separate atomic Fix commit, then run the isolated P6 browser case.
- Stop condition: Stop at `MILESTONE_CANDIDATE` / `AWAITING_ACCEPTANCE`, or earlier only for an unresolvable dirty-file ownership conflict, missing required hardware/credentials, or a material scope/architecture change.

## Smoke failure and repair ledger

| Evidence | Product failure | Root cause | Fix status |
| --- | --- | --- | --- |
| `.tmp/m10-self-test/browser.log` | G1 emitted `runtime-error` instead of `ready`: `THREE.GLTFLoader: Failed to load buffer "data:application/octet-stream;base64,..."`. | The generated JSON glTF used an embedded data-URI buffer. The sandbox CSP permits only `connect-src 'self'`, so GLTFLoader's secondary fetch was rejected. | Repaired by generating one self-contained binary `.glb`; build contract updated to parse the GLB JSON chunk and require `model/gltf-binary`. Validated by the final targeted G1 run. |
| `.tmp/m10-self-test/g1-browser-debug.log` | G1 emitted `runtime-error` instead of `ready`: `TypeError: Illegal invocation` in `setup`. | Assigning `canvas.tabIndex = 0` invoked a DOM property setter through the Runtime canvas proxy with an invalid receiver. | Repaired with proxy-safe `canvas.setAttribute("tabindex", "0")`. Validated by the final targeted G1 run. |
| `.tmp/m10-self-test/g1-browser-fixed.log` | Pause assertion observed additional movement between the pre-command sample and the paused frame. | The test sampled position before sending `timeScale=0`, allowing normal animation frames during command transit. | Repaired by sampling `pauseStart` after the `time-scale` acknowledgement, then comparing paused position to that anchor. |
| `.tmp/m10-self-test/g1-browser-fixed-2.log` | Browser-problem gate found two `GLTFLoader: Missing min/max properties for accessor POSITION` warnings. | The generated morph POSITION accessor omitted required bounds. | Repaired by adding deterministic `min`/`max`; final targeted G1 result records `browserProblems: []`. |
