# Security

## Report a Vulnerability

Use GitHub private vulnerability reporting when it is enabled for the
repository. If it is unavailable, open a public issue requesting a private
contact channel without including vulnerability details. Do not include
credentials, private project source, or unredacted DSH Session data in a
public issue.

Include the affected version or commit, operating system, reproduction steps,
expected boundary, observed behavior, and the smallest safe evidence needed to
confirm the issue.

## Security Model

`threejs-editor-mcp` is a local stdio MCP Server. It assumes the Server process,
its configured project root, and the current operating-system user are trusted.
Project source and assets may be untrusted.

The main boundaries are:

- model-visible tools address projects by opaque `projectId`, not arbitrary
  absolute paths;
- a Linked Workspace must come from trusted DSH Workspace metadata or an
  explicit `--workspace projectId=path` registration beneath
  `--workspace-root`;
- Workspace paths reject traversal, symlinks, hardlinks, unexpected file
  types, and quota violations;
- writes require the exact base revision and use transaction metadata plus
  atomic rename;
- build resolves only Workspace files and the fixed dependency profile;
- project code is bundled by the Server but executes only in the nested
  Runtime iframe;
- the Runtime iframe has `sandbox="allow-scripts"` without
  `allow-same-origin`;
- Runtime messages bind project, revision, run, nonce, and Runtime ownership;
- bundle and asset resources bind project and revision or build identity; and
- Runtime teardown removes listeners, object URLs, renderer state, and owned
  GPU resources.

The MCP App declares no external resource or frame domains. Runtime networking
is therefore unavailable under the current CSP. Adding network, worker,
pointer-lock, microphone, or other browser capabilities requires an explicit
security review and corresponding negative tests.

## Data on Disk

V1 Scene projects are stored beneath the configured `--root`. Managed V2
Workspaces are stored beneath `<root>/.managed-workspaces`. Linked Workspaces
remain in their original directories and receive `.threejs-editor` revision,
transaction, build, and diagnostic metadata.

The Server does not upload project source or assets. The configured MCP Host
and LLM provider are separate trust boundaries; review their data handling
before exposing private source to model-visible tools.

## Current Limits

Default V2 Workspace limits are 2,048 files, 16 MiB per file, and 128 MiB
total. Server flags can reduce or raise these values within the hard per-file
limit. A single model tool mutation is limited to 1 MiB.

V1 Scene assets are limited to eight files, 256 KiB each, and 512 KiB total.
Accepted types are GLB, PNG, and JPEG, with signature and GLB structure checks.

These controls bound local processing; they are not a multi-tenant isolation
claim. Do not expose the stdio Server as an unauthenticated network service.

## External Cases

External compatibility corpora are test inputs, not package content. Pin the
repository commit, record the license, keep distribution as `external-only`,
and run project code only through the Runtime Sandbox. Do not copy external
source or assets into the npm tarball without a file-level license review.
