# Editor Continuity Protocol

Status: M8.1 implementation contract

## Identities

The protocol keeps project, view, and execution identity separate:

```text
Project        = projectId
Revision       = SHA-256 of canonical project content
EditorInstance = Harness Session + MCP server + projectId
Runtime        = projectId + revision + runId + nonce
Owner          = Harness Session + MCP connection generation
```

An imported example derives `projectId` from its authorized source root and relative
project path. Content changes create a new revision without changing that ID.
`toolCallId` remains audit metadata and never owns the live Editor.

## Source Reconciliation

Imported examples are managed copies. Their `.threejs-editor/source.json` record
contains the source root, relative project path, entry, source revision, and hashes of
the imported files.

Every managed-project load rescans only the allowlisted import closure:

1. unchanged source returns the current managed revision;
2. changed source files become one transactional `apply_project_files` equivalent;
3. a managed file that has diverged from its recorded source hash raises a conflict;
4. paths, symlinks, file sizes, dependency profiles, and the 100-file mutation bound
   use the existing Workspace confinement checks.

The source tree is never written. A conflict tells the caller to edit the managed copy
or discard its local divergence before synchronization.

## Editor Ownership

`dsh-uni-editor` keys an App instance by Session, MCP server, and stable project ID.
Later mutation results route to that owner and update it in place. Duplicate transcript
rows become lightweight links to the owner. A live iframe and `AppBridge` are parked
outside virtualized rows and moved back when the owner remounts.

A reconnect creates a new MCP client, changes the connection generation, and resynchronizes
tools, views, and prompts. The old generation cannot control the replacement Runtime, and
cleanup deletes a persistent entry only if it still owns that exact entry. Failed App
initialization retains the card and exposes Retry.

## Revision Updates

The Editor polls the authoritative project revision and applies one of two paths.

Clean state:

- mappable selection, camera, layout, and editor operations are retained;
- command-only changes roll the existing Runtime to the exact new revision;
- source changes build and preflight an isolated candidate before replacing the
  visible Runtime;
- the old Runtime is disposed before the new run is registered.

Dirty state:

- the local draft is not overwritten;
- `Review later` retains the conflict;
- `Save local revision` rebases the file draft or pending editor commands onto the
  remote revision through an atomic project mutation;
- `Load external` explicitly discards the local draft.

A failed build or candidate Runtime leaves the last-good visible Runtime mounted.
Runtime messages are accepted only for their exact identity. Disposal cancels input,
animation, controls, renderer resources, WebGL context, pending commands, and server
ownership.

## Capability Manifest

A Workspace revision may declare:

- one parameter panel referencing declared parameters;
- one undoable official Editor command;
- one declared debug surface;
- one extension whose path is the Workspace entry and whose only permission is
  `runtime`.

The Server validates identifiers, references, command types, debug modes, extension
path, permissions, text type, file bounds, and normal Workspace confinement before the
manifest reaches the Editor. Extension code executes only in the Runtime iframe. It
does not execute in the Harness Host DOM and receives no arbitrary filesystem API.

## Runtime Harness

The Three.js Server owns:

- `capture_runtime_frame`
- `read_runtime_logs`
- `simulate_player_actions`

The Host transports standard MCP calls and rich content without interpreting Three.js
semantics.

Each request requires the exact Runtime identity and owner metadata. Commands target an
isolated validation Runtime by default. Active Runtime access additionally requires
`activeIntent: "user-requested"` and a current one-shot grant issued from an explicit
Editor UI action. The Server binds that grant to the exact Runtime and owner, expires it
after 60 seconds, and consumes it before dispatch.

The broker permits one pending command per Project and Owner. Cancellation, timeout,
revision rollover, disposal, stale identity, foreign Session, or foreign connection
generation rejects the command and releases the lease. `waitFrames` uses the Server
command expiry rather than a separate fixed deadline.

The Runtime accepts at most 32 normalized actions per call:

```text
pointerMove pointerDown pointerUp click drag wheel keyDown keyUp waitFrames
```

Logs use a 2,000-entry ring, 2,048-character messages, cursor pagination, and a
500-entry response limit. Captures copy only the Runtime canvas and are bounded to
1,024 pixels per dimension and 512 KiB of base64 data.

At registration the Server issues an evidence token. The parent sends it in the initial
Runtime bootstrap message before project code is imported. Evidence must carry that token
back to both the parent and Server, while model-visible tool results strip it. The token
binds evidence to the registered Runtime and prevents accidental or cross-Runtime
attribution; project code executing in the same Runtime realm is not treated as a separate
tamper-resistant security principal.

## Prompt Lifecycle

The Server owns `threejs-runtime-validation`. `dsh-uni-editor` hashes the rendered
content and injects one scoped section per server and prompt generation:

- identical reconnect content is deduplicated;
- changed content replaces the section for later Agent steps;
- disposal removes the section;
- only user-role text is accepted;
- passthrough does not create tools, raise priority, or widen permissions.

The visual branch is binary. Image-capable models inspect
`capture_runtime_frame`; models without image input stop visual inference, request
specific user observations, and wait. Human observations remain manual evidence.

## Recovery

Session history retains the project-bound result used to reconstruct the card. The
persistent App Runtime survives transcript virtualization within the live page.
Reload creates one replacement instance, pulls the current authoritative revision,
and restores the card. Temporary MCP unavailability triggers bounded automatic
reconnect; the replacement connection rotates generation, resynchronizes its catalog,
and deduplicates unchanged Prompt sections by hash. Stale generations cannot control
the replacement Runtime.

The protocol intentionally does not provide collaborative text merging, arbitrary
Host extensions, arbitrary dependency loading, or a generic Runtime Harness contract
for other Editor providers.
