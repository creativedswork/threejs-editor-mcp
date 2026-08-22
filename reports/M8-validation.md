# M8 Validation Report

Date: 2026-08-22
Accepted: 2026-08-23
Status: **ACCEPTED**

## 中文审阅摘要

M8 已完成交互式多 Pass WebGL、Runtime 输入所有权、GPU 资源生命周期和
Human/Replay 协作闭环：

- P2 Touch-History Frost 支持 pointer deposit、history ping-pong、衰减、
  resize reset 和独立 history debug surface；
- P3 Interactive Pool Volume 支持球体拖拽、水面扰动、wave propagation、
  normals、caustics 和 final debug surface；
- Runtime 在 `edit` mode 保留真实 Scene graph、Properties、Gizmo 和画布，
  在 `run` mode 独占示例输入；
- pointer capture、pointer cancel、OrbitControls、TransformControls 和场景拾取
  统一按输入所有权协调；
- 自定义示例负责 render path，不再被 Runtime 强制追加默认
  `renderer.render(scene, camera)`；
- Human 保存球体位置后，Replay assistant 在 exact revision 上把源码
  `damping` 从 `0.995` 改为 `0.992`；
- revision rollover 期间取消 in-flight build，Stop 在 11.5 秒门限内完成，
  后续 clean reload 使用新 build 和新 run ID；
- Play/Stop 重复 10 次后，Frost texture 数量、listener 数量和 pointer capture
  均保持稳定；
- Runtime 启动失败会发出 `runtime-error`，随后可通过 Stop 重放 `disposed`；
- diagnostics 绑定最终 revision 和 run ID，errors/warnings 均为空；
- 切换到普通 Scene 后，旧 Workspace 的 `active-run.json` 为零长度 tombstone；
- 修改工具不会隐式创建 MCP App 卡片；工具契约要求修改后显式调用
  `open_editor({ projectId })`，Replay 在无 reload 条件下固定卡片数
  `0 -> 1 -> 2 -> 2`；
- 最终独立审查没有 P0、P1 或 P2 finding；
- `release:check`、29 个 Node tests、fixed corpus build 和 packed install 均通过。

用户于 2026-08-23 验收 M8 并明确授权原子提交。M8.1 保持 `PLANNED`，
本次收口未实施 M8.1，也未进入 M9。

## Scope

M8 extends the M7 dual-mode Runtime rather than adding a separate player:

```text
exact Workspace revision
-> edit mode: render + inspect + transform
-> run mode: simulation + runtime-owned pointer input
-> stop: return to edit mode
-> revision rollover: dispose old run + build + clean reload
```

The Server still builds source without executing project code. Example code runs only
inside the opaque Runtime iframe.

## Pool Float / UI Closeout

The follow-up debug session was accepted and closed with M8 on 2026-08-23. Its
excluded evidence remains preserved and unmodified in
`debug-pool-float-ui-refresh.md` and `.dbg/`:

- the original Session had one `open_editor` call/result at seq `824/825`;
  `apply_project_files` first followed at seq `32188/32189`, with no later
  `open_editor`, so the missing card was a model workflow/tool-contract gap rather
  than a Host slot or rebind defect;
- pre-fix Runtime evidence put the sphere center at sampled water height and then
  strongly filtered later height changes, leaving the sphere partly submerged with
  barely visible movement;
- the isolated Managed Workspace fix at revision
  `deb5e1276287af9e015d027fbe294b47af5e7037aa8677b61f0ae4d1b8a94009`
  uses `meshY = sampledHeight + radius`;
- all 10 post-fix lines were captured on Apple M4 Pro / ANGLE Metal / DPR `1.25`;
  spawn and frame 60 both satisfy the equation exactly, and their Y delta is
  `0.013612985610961914`;
- the 1.5 MB original Session remains outside the repository. The product change is
  limited to precise tool descriptions and small unit/Replay assertions.

## Results

| Gate | Evidence | Result |
|---|---|---|
| Hardware renderer | `ANGLE Metal Renderer: Apple M4 Pro` | PASS |
| DPR | Runtime and drawing buffer verified at `1.25` | PASS |
| Frost input | pointerdown/move/up changed deposit history | PASS |
| Frost temporal state | deposit, previous-history and decay hashes differ | PASS |
| Frost resize | history reset once; texture count stayed at 12 | PASS |
| Frost lifecycle | 10 Play/Stop cycles; 6 listeners; 0 captured pointers | PASS |
| Pool input | dragged sphere changed bounds without moving camera | PASS |
| Pool simulation | pointer changed heightfield and waves propagated | PASS |
| Pool debug passes | height, normals and caustics produced distinct hashes | PASS |
| Pool final surface | non-black frame with more than 128 sampled colors | PASS |
| Human save | sphere Y persisted as `-0.68` in Editor commands | PASS |
| Assistant source edit | Replay changed one `damping` value to `0.992` | PASS |
| In-flight cancellation | Stop cancelled a delayed build before its 12 second response | PASS |
| Clean reload | new revision, build ID and run ID; old run fully disposed | PASS |
| Diagnostics | exact revision/run ID; 0 errors; 0 warnings | PASS |
| Startup failure | `runtime-error -> disposed` protocol | PASS |
| Scene switch cleanup | old `active-run.json` became a zero-length tombstone | PASS |
| MCP App cards | no reload; count `0 -> 1 -> 2 -> 2`; one main-frame navigation | PASS |
| Browser problems | no console errors or page errors | PASS |

## Fixed Corpus

Repository:

```text
https://github.com/scottstts/Threejs-Awesome-Graphics-Agent-Skills
```

Pinned commit:

```text
98453747cc0678f6a5d910f38d7483596a5f9a40
```

The source checkout remained clean. `tests/m8-corpus-build.mjs` verified:

| Example | Revision | Build ID | Bundle bytes | Inputs | Assets |
|---|---|---|---:|---:|---:|
| Touch-History Frost | `4f9bbf2a...d277` | `992d142a...25cf` | 3,057,648 | 8 | 4 |
| Interactive Pool Volume | `5e4f40ce...0c92` | `4da243b6...a9af` | 2,258,191 | 8 | 6 |

Both builds used the WebGL profile, embedded only manifest-declared image assets,
returned no diagnostics, and included their required helper module.

## Hardware Browser Evidence

The final candidate used:

```text
Harness URL:    http://127.0.0.1:14733
DSH_HOME:       /private/tmp/threejs-editor-m8-close.yRmjUe/home
Projects root:  /private/tmp/threejs-editor-m8-close.yRmjUe/projects-pass
Workspace root: /private/tmp/threejs-m8-corpus-close.Al8c0d/repo/dev/example-gallery/examples
Browser:        system Google Chrome through Playwright
Viewport:       1440x1000, then 1200x820
DPR:            1.25
GPU:            ANGLE Metal Renderer: Apple M4 Pro
Transport:      deterministic Replay through the real Harness Agent Loop
```

Replay used predetermined model chunks. It proves the Harness Session, Agent Loop,
MCP tool, MCP App and Runtime integration, but does not prove a live external model
API call.

The final Runtime evidence was:

```text
Frost build ID:       992d142a9f4b8bb5ac486a30e332f19d1e4b3025ea3183871d783b847d3725cf
Frost GPU textures:   12
Frost input listeners: 6
Frost Play/Stop:      10 cycles

Pool initial revision: 5e4f40ce5bea5984125a201f0ee205bd7fc07f799b555e0ed5fecc8b8a2b0c92
Human revision:       51d66610f6079af57fd4b937915f79aa473000fa6836b71833082e414a75ee18
Assistant revision:   31055ee0c1d24f1ccd8eefab6235988317ec49333a614043460ffcac7bdef697
Pool final build ID:  b7fdfe280f1d1f01b543533f2671b0c9537da742b3f75a1ea7a72a7893d73840
Previous run ID:      a2ade495-18f0-493c-bed8-b9f23e410e0d
Final run ID:         46ee94d0-dfc1-4f73-8a97-0f20f8c48417
Pool GPU textures:    5
Pool input listeners: 4
Diagnostics:          0 errors, 0 warnings
MCP App cards:        0 -> 1 -> 2 -> 2, no main-frame reload
```

The Replay Session was:

```text
session-6bd6f15b-85cb-46b0-9921-1c1fdcd2cbe3
```

It recorded the exact tool-call sequence:

```text
open_editor(Frost)
open_editor(Pool)
read_project_files
apply_project_files
build_project
check_project
check_project(final Runtime diagnostics)
```

The final model-visible `check_project` result reported exact revision
`31055ee0c1d24f1ccd8eefab6235988317ec49333a614043460ffcac7bdef697`,
run ID `46ee94d0-dfc1-4f73-8a97-0f20f8c48417`, 0 errors and 0 warnings.

The browser test completed every assertion and emitted its final JSON result. After
Chrome exited, the TRAE command wrapper reported restricted writes to Chrome's global
Crashpad, RLZ and updater bookkeeping paths. Those writes are outside the test
workspace and occurred after the browser evidence completed; no application assertion,
project write or corpus write was blocked. A second complete run produced the same
application result and the same wrapper-only restriction.

## Resource Lifecycle

| Resource | Owner and creation | Reset / disposal boundary | Final evidence |
|---|---|---|---|
| Runtime iframe identity | App creates one run for `projectId + revision + runId + nonce` | Stop, project switch, revision rollover or pagehide | stale events rejected; startup failure disposed |
| Bundle Blob URL | Runtime bootstrap creates one URL per accepted bundle | `URL.revokeObjectURL()` during run cleanup | clean reload used a new run and no old messages |
| Animation frame | Runtime owns one scheduled frame | cancelled before example and renderer disposal | no post-stop messages |
| Renderer | one `WebGLRenderer` per active Runtime | example dispose, controls dispose, then renderer dispose | `rendererDisposed=true` |
| Orbit/Transform controls | Runtime owns controls for the current scene | disposed before renderer teardown | selection/camera remained coherent |
| Forwarded input listeners | example registers against the Runtime canvas facade | listener registry removed on dispose | Frost 6, Pool 4, both stable |
| Pointer capture | Runtime facade tracks pointer IDs | pointercancel + release on Stop/dispose | 0 captured pointers after every Stop |
| Resize state | Runtime resizes renderer and calls example resize | temporal example resets history on size change | DPR 1.25 buffer; one settled resize |
| Frost temporal targets | Frost example owns ping-pong history and deposit resources | example `dispose()` before renderer disposal | 12 textures across 10 cycles |
| Pool simulation targets | Pool example owns height/velocity/normal ping-pong state | simulation `dispose()` | 5 textures at final run |
| Pool caustics target | `PoolCausticsPass` owns its render target | pass `dispose()` | distinct caustics hash |
| Example geometry/materials | example owns meshes, shader materials, cubemap and tile texture | example `dispose()` | 19 geometries, 9 programs before teardown |
| Active run record | MCP Server registers exact revision/run ownership | release or project switch writes zero-length tombstone | tombstone size `0` |
| Runtime diagnostics | Server persists exact tested revision/run | replaced only by a valid current run | final revision/run matched; no findings |

Disposal order is intentional:

```text
cancel animation
-> cancel pointer capture
-> example.dispose()
-> TransformControls.dispose()
-> runtime input facade cleanup
-> OrbitControls.dispose()
-> renderer.dispose()
-> revoke bundle URL
-> release Runtime ownership
```

## GIF Evidence

The local GIF tells one five-state story:

1. Frost pointer deposit;
2. Pool edit mode;
3. Pool sphere drag and propagated water;
4. caustics debug pass;
5. assistant revision clean reload with diagnostics recorded.

```text
Path:          .playwright-mcp/m8-interactions.gif
Source frames: 5
Encoded frames:120
Dimensions:    1200x820
Duration:      12.0 seconds
Size:          601,289 bytes
SHA-256:       b1a32015c87b2893b28dd2d55f3946c1be93f17fc29562417ac027e97c17e71c
```

The encoded GIF itself was decoded at five representative timestamps and visually
checked. Frame order, palette, text, final hold and scene visibility were correct;
no blank frame, overlap, unrelated window or sensitive information was present.

## Independent Review

Three independent review groups covered Runtime protocol and disposal, builder/input
behavior, Workspace transactions and confinement, cross-process locks, Server tools
and the related tests.

Final result:

```text
P0: 0
P1: 0
P2: 0
```

Validated review artifacts:

```text
/private/tmp/threejs-editor-mcp_m8-final-review-20260822p/report.html
/private/tmp/threejs-editor-mcp_m8-final-review-20260822p/report.md
/private/tmp/threejs-editor-mcp_m8-final-review-20260822p/final_comments.json
```

`final_comments.json` is `[]` and passed the review schema validator.

A post-E2E targeted audit then found two P1 and one P2 evidence-harness gaps:
the startup probe did not filter full Runtime identity, the diagnostics assertion did
not exercise the production `check_project` path, and a `newPage()` failure could
leave the browser open. All three were fixed. The targeted rereview found no
remaining P0, P1 or P2 issue:

```text
/tmp/threejs-editor-mcp_targeted-rereview-1787385804/report.html
/tmp/threejs-editor-mcp_targeted-rereview-1787385804/report.md
```

The `pool-float-ui-refresh` closeout received a separate independent contract
review. Its first pass found one P2: `open_editor` said all other project tools
did not create cards, although `create_project` and `create_workspace` do. The
description and unit assertion were narrowed to `apply_project_files`; the
independent rereview found no remaining P0, P1 or P2 issue.

Validated closeout review artifacts:

```text
/tmp/threejs-editor-mcp_m8-contract-review-20260822/report.html
/tmp/threejs-editor-mcp_m8-contract-review-20260822/report.md
/tmp/threejs-editor-mcp_m8-contract-review-20260822/final_comments.json
```

The closeout `final_comments.json` is `[]` and passed the review schema
validator.

## Verification

The final release gate covered:

```text
check:upstream: 28 files
focused server contract test: 1/1 PASS
typecheck: PASS
build: PASS
Node tests: 29/29 PASS
packed install: PASS
release:check: PASS
fixed corpus: 2/2 PASS
M8 browser assertions: PASS
```

Focused Workspace verification also passed `9/9`, including a deterministic
parent-directory swap regression for bound atomic replacement.

The fixed corpus command used `GIT_OPTIONAL_LOCKS=0` so read-only provenance checks
did not refresh the external repository index:

```sh
GIT_OPTIONAL_LOCKS=0 \
THREEJS_EDITOR_MCP_WORKSPACE=\
/private/tmp/threejs-m8-corpus-close.Al8c0d/repo/dev/example-gallery/examples \
pnpm run test:corpus:m8
```

## Human Acceptance (Completed)

1. Open `http://127.0.0.1:14733` and select the latest Replay session.
2. Confirm Frost and Pool are both present as MCP App cards without reloading Chat.
3. Open the current M8 GIF and confirm the five-state order.
4. Open Touch-History Frost, press Play, drag across the canvas and confirm deposit
   followed by decay.
5. Resize the App and confirm history resets without a black frame.
6. In the current Session on the acceptance service at `http://127.0.0.1:14733`,
   open the fixed post-fix Pool revision
   `deb5e1276287af9e015d027fbe294b47af5e7037aa8677b61f0ae4d1b8a94009`.
7. Press Play, click the water to spawn a sphere, and confirm its center stays above
   the water surface and visibly moves up and down with the wave height sampled at
   that same point.
8. Select and drag the sphere, then switch height, normals, caustics and final debug
   modes.
9. Stop, change Position Y, save, then ask the assistant to change damping.
10. Without reloading Chat UI, explicitly invoke `open_editor` and confirm its card
    appears immediately. Confirm `apply_project_files` itself creates no new card and
    that the assistant invokes `open_editor` again after modifying the project.
11. Confirm the existing Pool card cleanly reloads the new revision and Stop reports
    recorded diagnostics.

Recorded decision on 2026-08-23: `提交 M8 并进入 M8.1`.

This accepts M8 and authorizes its atomic commit. M8.1 remains planned and was not
implemented as part of this closeout.
