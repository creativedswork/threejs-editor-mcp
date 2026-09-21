# Dependency Profile

Workspace projects do not install packages. The Server builds source against
one fixed browser dependency profile from its own installation.

## Included Packages

| Import | Version | Purpose |
| --- | --- | --- |
| `three`, `three/webgpu`, `three/tsl`, `three/addons/*` | 0.185.1 | Three.js core, WebGL, WebGPU, TSL, loaders, controls, and post-processing modules |
| `postprocessing` | 6.39.5 | Effect pipeline compatibility |
| `three-stdlib` | 2.36.0 | Additional Three.js utilities |
| `astronomy-engine` | 2.1.19 | Astronomy calculations used by verified cases |
| `@petamoriken/float16` | 3.9.2 | Half-float data conversion used by verified cases |

`src/builder.ts` owns the exact versions and import resolution.
`package.json` pins the same versions. The build ID includes the complete
profile string, so a profile change invalidates prior build cache entries.

## Resolution Rules

The builder accepts:

- relative modules inside the revision;
- root-relative `/dev/...` and `/skills/...` modules for the fixed Gallery
  corpus adapter;
- the package imports listed above; and
- pinned Three.js Draco and Basis decoder assets.

It rejects other bare package imports. The Server does not consult a project's
`node_modules`, lockfile, CDN imports, import map, or lifecycle scripts.

Text modules may use JS, JSX, TS, TSX, MJS, CJS, JSON, CSS, GLSL, WGSL, or TSL
as supported by the builder. Referenced browser assets are revision-bound and
delivered to the Runtime by content digest. Assets larger than 256 KiB use
chunked MCP resources instead of bundle inlining.

## Add a Package

Add a package only when a reproducible case requires it:

1. Pin the exact runtime version in `package.json`.
2. Add the same package and version to
   `PINNED_RUNTIME_DEPENDENCIES` in `src/builder.ts`.
3. Confirm that the package has a browser entry and does not require install
   scripts, Node built-ins, unrestricted network access, or unsupported
   workers.
4. Record license and attribution changes in `THIRD_PARTY_NOTICES.md` when the
   package license requires it.
5. Add or update a community case with the appropriate WebGL or WebGPU lane.
6. Verify build diagnostics, Runtime ready, capture, case-specific behavior,
   teardown, and packed installation.

Do not add dynamic package installation, semver ranges, CDN fallback, or a
second profile until a confirmed case cannot be supported by this fixed
profile.

## Change Review

A dependency profile change affects every Workspace build. Review:

- package and transitive license changes;
- browser bundle size and generated source limits;
- CSP, network, worker, and WebAssembly requirements;
- WebGL/WebGPU backend compatibility;
- source-map behavior;
- asset decoder files and MIME types; and
- build cache invalidation.

The external corpus remains outside the npm package even when the profile can
build it.
