# M7 Session Regression Validation

Status: **PASS, awaiting user approval**

Source evidence:

`session.jsonl` supplied by the user.

## Corrected Behaviors

1. Human Save commits the new revision without replacing or hiding the active
   Runtime iframe. Camera, selection, WebGPU canvas, and pixel output remain
   visible.
2. `threejs.editor.json` keeps a bounded audit of `human` and `ai` operations.
   `inspect_project` and `inspect_editor` return object name, scene path, UUID,
   operation type, and final value.
3. Scene graph navigation supports hierarchy collapse, object search, and
   reveal-selection. Repeated clicks at one viewport position cycle through
   overlapping raycast hits.
4. External revisions finish `build_project` and bundle retrieval before the
   current Runtime is stopped.

## Original Session Audit

The reported save was valid:

```text
base revision: 91f10eda13f5f0d97b1ea5629d005d961075cd9888350bd9801b1f94fbbb1828
saved revision: a5c5e17c1f20da955746dbe434c5e63f32af31e9f8a937a45304628a084a51df
build status: ready
diagnostics: 0
```

Five persisted operations moved `helmet`, `sidepod`, an unnamed `Mesh`,
`tyre.RR`, and changed visibility on `inletLip.L`. The old
`inspect_project` response incorrectly returned the two-light projection and
`operations: []`, which caused the model to inspect the read-only corpus.

## Deterministic Browser

```text
save continuity: same Runtime iframe
pixels before save: 7,784 / 9,000 lit; 1,163 colors
pixels after save:  7,707 / 9,000 lit; 1,199 colors
overlapping selection cycle: PASS
search + reveal selection: PASS
Human revision -> AI revision -> Play -> Stop: PASS
App problems: 0
```

## Real DeepSeek

```text
Session: session-a629ddc6-d8df-46a1-ad2e-f76bdc557901
Provider: deepseek-official
Model: deepseek-v4-flash
```

Strict model-visible tool sequence:

```text
mcp__threejs__list_projects({})
mcp__threejs__open_editor({
  "projectPath": "threejs-procedural-geometry/formula-one-race-car"
})
mcp__threejs__inspect_project({
  "projectId": "example-f1360b08b9d9ea912ce2ad83ae72866e5a24f4540c5a50955ac7a6fa"
})
```

After the Human set `VF-26.position.x` to `0.25`, the model reported:

```text
source: human
operation: set_position
object: VF-26
path: scene/VF-26#0
value: [0.25, 0, 0]
```

No shell, generic file tool, npm, gallery server, or HTML fallback was used.

Visual evidence:

- [Human edit recalled by DeepSeek](assets/m7-session-human-edit-recall.png)
- SHA-256:
  `d315fdf1babde09136b4b0c07f45e1fd66ac4c8cab45502d83c1ff53e1f805ed`

The Chrome process still exits non-zero after all business assertions because
the TRAE sandbox denies Crashpad and Google Updater writes outside the
workspace. This is an environment cleanup side effect, not a product failure.
