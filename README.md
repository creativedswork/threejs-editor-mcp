# threejs-editor-mcp

English | [简体中文](README.zh-CN.md)

Build and tune Three.js projects with an AI Agent inside DeepSeek Harness.
The Agent edits source. You inspect the live scene, move objects, adjust
parameters, and press Play in the same chat card. Both sides work on the same
project revision.

<img width="1000" height="400" alt="Three.js projects open in MCP Apps" src="https://github.com/user-attachments/assets/dab21bc8-540d-4582-ab0d-1a9013805ab0">

[Watch the 80-second showcase](https://www.youtube.com/watch?v=pbrUQos2n9k)
· [Install](#install)
· [Migrate from V1](docs/MIGRATION.md)
· [Add a community case](docs/COMMUNITY-CASES.md)

## What 0.2.0 adds

- Open an authorized local project as a Linked Workspace and edit it in place.
- Build multi-file ESM, TypeScript, GLSL, WGSL, and TSL for WebGL or WebGPU.
- Keep Scene, Properties, TransformControls, parameters, source files, and
  Runtime diagnostics tied to one revision.
- Run project code in a nested sandbox that owns its renderer, loop, input,
  assets, and GPU cleanup.

```text
Agent edits source
-> Editor reloads the revision
-> You adjust the scene or parameters
-> Play runs that revision
-> Runtime evidence informs the next Agent turn
```

## Architecture

```mermaid
flowchart LR
  Agent["Harness Agent"] -->|"model-visible tools"| Host["dsh-uni-editor"]
  Host --> Server["threejs-editor-mcp<br/>stdio server"]
  Server --> Store["project.json<br/>diagnostics.json<br/>assets/"]
  Server -->|"resources/read"| App["MCP App Sandbox<br/>Three.js Editor"]
  App -->|"app-only tools"| Host
  Human["Human"] --> App
```

The Editor uses the official `three` npm package. It is a product-owned,
lightweight editor inspired by the official Three.js Editor; no Editor source
is vendored and no separate web service is required.

## Install

Install the MCP Apps Host and this MCP Server:

```sh
dsh plugin --profile web add @creative-dswork/dsh-uni-editor
npm install --global threejs-editor-mcp@0.2.0
threejs-editor-mcp --root /absolute/path/to/threejs-projects
```

Or run the Server without a global install:

```sh
npx --yes threejs-editor-mcp@0.2.0 --root /absolute/path/to/threejs-projects
```

For a global install, configure the `mcp-apps` row in
`~/.dsh/profiles/web/cordis.patch.yml` (or
`$DSH_HOME/profiles/web/cordis.patch.yml` when set) and replace the initial
`[]`:

```yaml
- id: mcp-apps
  config:
    maxBodyBytes: 2097152
    servers:
      - serverName: threejs
        transport: stdio
        command: threejs-editor-mcp
        forwardWorkspace: true
        args:
          - --root
          - /absolute/path/to/threejs-projects
```

To let npm resolve the package directly, use `npx` in the same configuration:

```yaml
- id: mcp-apps
  config:
    maxBodyBytes: 2097152
    servers:
      - serverName: threejs
        transport: stdio
        command: npx
        forwardWorkspace: true
        args:
          - --yes
          - threejs-editor-mcp@0.2.0
          - --root
          - /absolute/path/to/threejs-projects
```

The root can also be provided with `THREEJS_EDITOR_PROJECT_ROOT`. It stores
managed projects and is not the local game directory selected in DSH Web.

Start DSH Web, add the existing Three.js project as the current Workspace, and
ask the Agent to open the current project. The Editor opens that directory in
place; no path is passed as a model tool argument. See
[User Operations](docs/USER-OPERATIONS.md) for the development workflow and
security boundaries.

## Capabilities

- `empty` and playable `pong` project templates;
- hierarchy, viewport picking, transform controls, Inspector, undo/redo;
- V1 Scene projects with one `start` / `update` / `dispose` game script;
- V2 Linked and Managed Workspaces with multi-file ESM/TypeScript, shaders,
  WebGL, WebGPU, source maps, and revision-bound assets;
- isolated Runtime ownership for renderer loops, keyboard, and pointer input;
- revision-checked human saves and model changes;
- revision-bound Play diagnostics;
- GLB, PNG, and JPEG import plus self-contained project export;
- clean reload and dirty conflict preservation.

Model-visible tools:

`list_projects`, `create_project`, `open_editor`, `inspect_project`,
`apply_scene_changes`, and `check_project`.

App-only tools:

`pull_project`, `push_project`, `save_project_copy`, `report_diagnostics`,
`put_asset`, and `export_project`.

## Asset Limits

Assets are local only. V1 Scene assets are limited to 256 KiB each, eight files,
and 512 KiB total. V2 Workspaces default to 2,048 files, 16 MiB each, and
128 MiB total. The Server validates paths, file ownership, quotas, content
digests, and supported asset forms.

The JSON export contains the saved project, exact revision, and base64 copies
of its original assets. The MCP Apps Host mediates the download because direct
downloads are blocked inside the Sandbox.

## Development

Requires Node.js 22.19 or newer and pnpm 10.25.

```sh
pnpm install
pnpm run check
pnpm run test:pack
```

Run the server directly:

```sh
pnpm run build
node dist/server.js --root .tmp/projects
```

See [Contributing](CONTRIBUTING.md), [Community Cases](docs/COMMUNITY-CASES.md),
[V1/V2 Migration](docs/MIGRATION.md), and
[Dependency Profile](docs/DEPENDENCY-PROFILE.md).

## Security

Projects and assets are confined to the configured root. Project writes are
size-bounded, revision-checked, serialized per project, and committed with
temporary-file rename. Project paths, asset paths, symlinks, stale revisions,
oversized payloads, mismatched file types, and external asset URLs are rejected.
Game scripts run only in the existing different-origin double iframe Sandbox.
See [Security](SECURITY.md) for the threat model and reporting process.

## License

MIT
