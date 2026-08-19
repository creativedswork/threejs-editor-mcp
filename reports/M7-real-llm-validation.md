# M7 Real LLM Validation

Date: 2026-08-19
Status: **PASS after second acceptance correction, awaiting renewed M7 approval**

## 中文审阅摘要

本轮使用 fresh DSH Web profile 和真实 `deepseek-official /
deepseek-v4-flash`，未加载 Replay。模型自主完成：

```text
open_editor
-> build_project
-> read_project_files
-> apply_project_files
-> build_project
-> check_project
```

模型只调用 Three.js Editor MCP tools，把 `bodyScale` 从 `1` 改为 `1.02`，
保留 `livery: false`，并在最终回答中准确报告修改前后的两个 revision 和两个
`buildId`。最终检查为 `0 errors, 0 warnings`。

用户验收随后确认：真实 Workspace 就是 corpus 的
`dev/example-gallery/examples`，不能改用仓库根替代验收。第二次修正后的 fresh
真实模型 Session 在该目录自主完成：

```text
list_projects({})
-> open_editor({
     projectPath:
       "threejs-procedural-geometry/formula-one-race-car"
   })
```

该 Session 没有调用 shell、普通文件工具、inspect/build、npm、gallery server
或 Web/HTML 工具，页面直接挂载 `mcp__threejs__open_editor` App。

## Environment

```text
Harness URL:     http://127.0.0.1:51839
Profile root:    /tmp/threejs-editor-m7-real-home-20260819-0003
Provider:        deepseek-official
Model:           deepseek-v4-flash
Reasoning:       high
Replay loaded:   no
Workspace:       .tmp/m7-real-workspace
```

The API key was supplied only to the Harness process environment. It is not
stored in the repository, trace, report, Workspace metadata, or Session log.

## Request

The model was asked to open the current Workspace, build its exact revision,
read `src/parameters.json`, change only `bodyScale` from `1` to `1.02` through
`apply_project_files`, build the new revision, run `check_project`, and report
both revisions and build IDs. Generic file writes and shell were forbidden.

## Tool Sequence

The durable Session log contains exactly these tool calls:

1. `mcp__threejs__open_editor`
2. `mcp__threejs__build_project`
3. `mcp__threejs__read_project_files`
4. `mcp__threejs__apply_project_files`
5. `mcp__threejs__build_project`
6. `mcp__threejs__check_project`

No generic filesystem write tool or shell command was called.

## Result

| Evidence | Before | After |
|---|---|---|
| revision | `13f5535c663575b6de9184230407308e670aaf12db92267dfcd4357971592f25` | `a966f60e291b4a0cc4eebb1088b24f6770321d55787c1bdcf56801a4d718bee8` |
| buildId | `b1817ed1d5e8ab3061b0b73fe6d35e57b363b18bd6956c928b57e11dc4aeab09` | `44c4541276d969618016be8922923f68b19177d578fd88d1a779042657c95eed` |
| bundle bytes | 3,168,165 | 3,168,168 |
| source map bytes | 6,560,648 | 6,560,651 |
| bodyScale | `1` | `1.02` |
| livery | `false` | `false` |
| diagnostics | 0 | 0 |

The transaction journal is `committed`, changes only
`src/parameters.json`, and the final Workspace `HEAD` equals the target
revision. `check_project` returned `0 errors, 0 warnings`.

## User Acceptance Regression

The rejected user Session used `dev/example-gallery/examples` as its DSH
Workspace. Formula One Race Car imports `/skills/...` and
`/dev/example-gallery/support/...`. The Server now:

1. discovers `example.json` projects without scanning unrelated assets;
2. returns only relative `projectPath` selectors to the model;
3. recognizes only the fixed `dev/example-gallery/examples` corpus layout;
4. reads only the same corpus's `dev/` and `skills/` static import closure;
5. materializes a source-revision-bound Managed Workspace without modifying
   the source repository;
6. opens that Workspace through the MCP App resource.

The fresh non-Replay regression environment was:

```text
Harness URL:   http://127.0.0.1:51844
Provider:      deepseek-official
Model:         deepseek-v4-flash
Reasoning:     high
Replay loaded: no
Workspace:     pinned corpus dev/example-gallery/examples
Session:       session-78e6ea2a-5d84-4313-ba84-00de74b11530
```

The durable Session contains exactly two tool calls:

```text
mcp__threejs__list_projects({})
mcp__threejs__open_editor({
  "projectPath":
    "threejs-procedural-geometry/formula-one-race-car"
})
```

The `list_projects` tool result contains 37 candidates: 33 ready and 4
restricted by bare dependencies outside the M7 runtime profile. The model's
natural-language total was inaccurate, so the report and trace use the MCP
tool result as the machine source of truth.

The opened opaque project was independently built from the same Managed
Workspace:

```text
projectId:      example-e997526fb0453fd60582b6a171aee02e8cd61371b8dac9437eb97e64
revision:       c5c0426da08b32e3256f9ffc68a4fed5e46fd7eebcf5690c8df630595e808c7f
buildId:        d9c8a13b0b72ceee8315084a14aae77a8565750d8d15b5a593be3818d49ad622
backend:        webgpu
inputs:         15
bundle bytes:   3,168,474
source map:     6,561,027
diagnostics:    0
```

The corrected run wrote only to the configured Managed Workspace root. A fresh
checkout of the pinned corpus remained clean after discovery, open, and build.
No `.threejs-editor`, copied source, rewritten import, or `node_modules` was
created in the corpus.

## Build ID Visibility

The first M7 real-model run exposed `buildId` only through structured content.
The model-visible text omitted it, so the model incorrectly claimed no build
ID was available. M7 now includes `buildId` in successful and failed
`build_project` text results.

The fresh run above loaded the fixed build. Its final answer accurately
reported both build IDs. The builder test also asserts model-visible build IDs
for both ready and failed builds.

## Evidence

- [Machine-readable trace](M7-real-llm-trace.json)
- [Gallery user-path trace](M7-gallery-real-llm-trace.json)
- [Real model build ID report](assets/m7-real-llm-build-id.png)
- [Direct MCP App open](assets/m7-gallery-direct-open.png)
- [Real model nested Gallery open](assets/m7-gallery-real-direct-open.png)
- Nested Gallery screenshot SHA-256:
  `d9c1bef02975bf1f24c87831d0910ab1c8908b3f79c84ca3a9145c6b0871a0a7`
- Durable Session:
  `session-78e6ea2a-5d84-4313-ba84-00de74b11530`

The Session source records:

```json
{
  "kind": "model",
  "provider": "deepseek-official",
  "model": "deepseek-v4-flash"
}
```

## Discarded Setup Attempt

An earlier fresh profile at port `51838` omitted the `dsh-mcp-apps` bundle, so
the model had no Three.js MCP tools. That run was stopped after one read-only
shell attempt and before any Workspace write. The Workspace was regenerated
from the pinned corpus before the passing run. It is not counted as M7
validation evidence.
