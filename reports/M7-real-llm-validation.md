# M7 Real LLM Validation

Date: 2026-08-19
Status: **PASS after acceptance correction, awaiting renewed M7 approval**

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

用户验收随后发现，直接把 corpus 的 `dev/example-gallery/examples` 设为 DSH
Workspace 时，旧版 `open_editor({})` 会扫描全部 37 个案例，被无关大资源阻断，
模型才退回 gallery server 和 HTML。修正后的第二个 fresh 真实模型 Session
改为选择 corpus 仓库根，并自主完成：

```text
list_projects({})
-> open_editor({
     projectPath:
       "dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car"
   })
```

该 Session 没有调用 shell、普通文件工具、npm、gallery server 或 Web/HTML
工具，页面直接挂载 `mcp__threejs__open_editor` App。

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

The rejected user Session used the nested `dev/example-gallery/examples`
directory as its DSH Workspace. Formula One Race Car imports `/skills/...` and
`/dev/example-gallery/support/...`, so that directory does not contain the
complete import closure. The Server now:

1. discovers `example.json` projects without scanning unrelated assets;
2. returns only relative `projectPath` selectors to the model;
3. refuses incomplete authorization roots with a structured instruction to
   select the repository root;
4. materializes a source-revision-bound Managed Workspace without modifying
   the source repository;
5. opens that Workspace through the MCP App resource.

The fresh non-Replay regression environment was:

```text
Harness URL:   http://127.0.0.1:51842
Provider:      deepseek-official
Model:         deepseek-v4-flash
Reasoning:     high
Replay loaded: no
Workspace:     pinned corpus repository root
Session:       session-fdb753b5-0339-41ba-8980-2b6796fe7067
```

The durable Session contains exactly two tool calls:

```text
mcp__threejs__list_projects({})
mcp__threejs__open_editor({
  "projectPath":
    "dev/example-gallery/examples/threejs-procedural-geometry/formula-one-race-car"
})
```

The opened opaque project was independently built from the same Managed
Workspace:

```text
revision:       ec973b281cbd45e87f8dd25d4dbaff25133eb766113d3f99d7b6174dc3f0a645
buildId:        36ea7bcb224e392f874db19a2f94e013e6401f4e09b8f0baf5c8af7d7e9d83fb
backend:        webgpu
inputs:         15
bundle bytes:   3,168,474
source map:     6,561,027
diagnostics:    0
```

The corrected run wrote only to the configured Managed Workspace root. It did
not create new metadata or dependencies in the corpus. Pre-existing
`dev/example-gallery/examples/.threejs-editor` and repository `node_modules`
artifacts from the rejected fallback Session were left untouched.

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
- Screenshot SHA-256:
  `93c60b49f057be8626cb03c187a308a5344ae17938a6316d807581f5a123837b`
- Durable Session:
  `session-3b13985d-e5c1-48ae-b98c-1b2fb27a9fb6`

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
