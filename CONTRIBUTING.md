# Contributing

## Prerequisites

- Node.js 22.19 or newer
- pnpm 10.25
- Chrome for browser capture and E2E checks

Install dependencies from the repository root:

```sh
pnpm install
```

## Choose the Smallest Change

Keep changes inside the component that owns the behavior:

| Area | Primary files |
| --- | --- |
| MCP tools and App resource | `src/server.ts` |
| V1 Scene projects | `src/projects.ts` |
| V2 Workspace revision and files | `src/workspaces.ts` |
| Workspace build | `src/builder.ts` |
| Workspace Runtime | `src/workspace-runtime.ts` |
| Editor App behavior | `src/view.ts` |

Do not add a second project discovery path, Runtime implementation, or
dependency installer. Reuse `example.json` discovery, the Workspace builder,
and the existing Runtime Sandbox.

## Development Checks

Run the narrowest check that covers the change while developing:

```sh
node --test tests/path-to-focused-test.mjs
pnpm run typecheck
```

Before a release candidate, run the repository checks:

```sh
pnpm run release:check
```

Browser and external corpus checks require their documented environment and
are not implied by unit or build success.

## Add a Community Case

Create a directory under `examples/` with:

```text
case.json
example.json
scene.js
```

Follow [Community Cases](docs/COMMUNITY-CASES.md), then run:

```sh
pnpm run validate:cases -- examples
pnpm run capture:case -- examples your-case
```

Repository-owned fixtures must use source and assets that this repository can
distribute. External corpus source stays in its original checkout and uses
`source.type: "external"` with an exact commit and license.

## Dependency Changes

The Server does not run `npm install` for projects. A new package must be added
to the fixed profile in `src/builder.ts`, pinned in `package.json`, covered by
license notices when required, and verified with a case that needs it. See
[Dependency Profile](docs/DEPENDENCY-PROFILE.md).

## Pull Request Evidence

Describe:

- the user-visible or protocol behavior changed;
- focused commands that passed;
- Runtime or browser evidence when applicable;
- checks not run and why;
- external source revisions and licenses; and
- compatibility identifiers intentionally retained.

Do not include generated external corpus files, `.tmp/`, `.playwright-mcp/`,
managed Workspace state, credentials, or local DSH profiles.
