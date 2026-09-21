# V1 Scene and V2 Workspace

V1 Scene projects and V2 Workspaces are separate supported formats. Upgrading
is optional. The Server does not rewrite a V1 project in place.

## Choose a Format

| Capability | V1 Scene project | V2 Workspace |
| --- | --- | --- |
| Storage | one `project.json` plus bounded assets | normal multi-file project plus `.threejs-editor` metadata |
| Entry | script body returning `start`, `update`, and `dispose` | ESM module default-exporting a Runtime adapter |
| Source | one script | JS/TS modules, shaders, JSON, CSS, and assets |
| Backend | WebGL | WebGL, WebGPU, or raw WebGPU |
| Dependencies | `THREE` supplied by the Scene Runtime | fixed browser dependency profile |
| Best use | small scenes and Pong-style games | multi-file games, advanced rendering, and source collaboration |

Keep a project on V1 when its single script and asset limits are sufficient.
Move to V2 when the project needs modules, shaders, larger assets, WebGPU,
source maps, or file-level AI edits.

## Export Formats

The Editor's Export command returns JSON:

- V1: `format: "threejs-editor-mcp"`, `formatVersion: 1`, project document,
  exact revision, and base64 assets.
- V2: `format: "threejs-editor-workspace"`, `formatVersion: 2`, Workspace
  manifest, exact revision, and base64 files.

Exports are backups and inspection artifacts. Version 0.2.0 does not provide a
command that imports either export file. Keep the original project directory
until the migrated Workspace has been built and run successfully.

## Migrate V1 to V2

1. Export the V1 project from the Editor.
2. Create a new local directory with `package.json` and `src/main.js`.
3. Copy the V1 export's `project.scene` value to `src/scene.json`.
4. Convert the V1 script body into a V2 Runtime adapter.
5. Select the new directory as the DSH Workspace and ask the Agent to open the
   current project.
6. Run `check_project`, open the Editor, verify edit mode, enter Play, stop, and
   reload the exact revision.
7. Compare scene objects, controls, assets, and diagnostics before retiring the
   V1 project.

A minimal package file is:

```json
{
  "name": "migrated-game",
  "private": true,
  "type": "module",
  "dependencies": {
    "three": "0.185.1"
  }
}
```

The V2 entry must default-export an adapter:

```js
import * as THREE from 'three'
import sceneDocument from './scene.json'

export default {
  backend: 'webgl',
  setup({ scene }) {
    const loaded = new THREE.ObjectLoader().parse(sceneDocument)
    scene.add(...loaded.children)

    return {
      update({ delta }) {
        // Move V1 update logic here.
      },
      metrics() {
        return { objects: scene.children.length }
      },
      dispose() {
        scene.traverse(object => {
          object.geometry?.dispose()
          const materials = Array.isArray(object.material)
            ? object.material
            : [object.material]
          for (const material of materials) material?.dispose()
        })
      },
    }
  },
}
```

Move V1 `start` logic into `setup`, V1 `update(context, delta)` logic into the
adapter's `update(frame)`, and V1 cleanup into `dispose`. This conversion is
manual because V1 scripts are arbitrary JavaScript and cannot be transformed
safely from syntax alone.

The default V2 manifest uses `src/main.js`, WebGL, the dependencies declared in
`package.json`, and `final`/`default` Runtime modes. Add
`.threejs-editor/project.json` only when the project needs a different entry,
backend, debug modes, quality tiers, parameters, or capabilities.

## Linked and Managed Workspaces

A Linked Workspace remains in the selected local directory. The Server writes
revision and recovery metadata beneath `.threejs-editor` and edits source in
place after revision checks.

A Managed Workspace is copied beneath `<root>/.managed-workspaces`. Gallery
examples use this mode so edits do not change the external corpus. Both kinds
use the same revision, builder, Runtime, file tools, and export format.

## Rollback

Migration does not modify the V1 source project. To roll back, reopen the V1
project ID. If a V2 edit is wrong, restore the local directory from version
control or a separate backup before making further edits. Version 0.2.0 does
not expose a public revision-restore command. Do not copy `.threejs-editor`
metadata between unrelated directories.
