# Community Cases

A community case is a Three.js example with reproducible compatibility and
capture metadata. Put `case.json` beside the example's existing `example.json`
and `scene.js`:

```text
examples/
└── my-case/
    ├── case.json
    ├── example.json
    └── scene.js
```

No central registry is required. The product already discovers `example.json`;
the case tools recursively discover `case.json`.

## File Responsibilities

| File | Owns |
| --- | --- |
| `example.json` | title, backend, viewport, DPR, debug modes, and controls used by project discovery and Runtime build |
| `scene.js` | Runtime adapter and project behavior |
| `case.json` | source license, compatibility lane, blocking status, and capture plan |

Do not copy fields from `example.json` into `case.json`. The validator reads
both files and rejects capture modes not declared by the example.

## Format

```json
{
  "schemaVersion": 1,
  "source": {
    "type": "repository",
    "license": "MIT"
  },
  "compatibility": {
    "level": "C1",
    "lane": "deterministic-core",
    "blocking": true
  },
  "capture": {
    "qualityTier": "default",
    "warmupFrames": 2,
    "frames": [
      {
        "id": "final",
        "debugMode": "final",
        "waitFrames": 1
      }
    ],
    "contactSheet": {
      "columns": 1
    }
  }
}
```

`source.type` is `repository` for source owned by this repository. External
source must use an exact 40-character Git revision and remain outside the npm
package:

```json
{
  "type": "external",
  "repository": "https://github.com/example/threejs-cases",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "license": "MIT",
  "distribution": "external-only"
}
```

Compatibility levels follow the definitions in
[the V2 plan](COMPLEX-GAME-EDITOR-PLAN.md#兼容性分级). C5 cases must be
non-blocking.

| Lane | Use |
| --- | --- |
| `deterministic-core` | repository-owned fixtures that run without external corpus or dedicated GPU hardware |
| `webgl-corpus` | pinned external WebGL cases |
| `webgpu-hardware` | WebGPU or raw WebGPU cases that require a hardware runner |

## Validate

From the repository root:

```sh
pnpm run validate:cases -- examples
```

To retain the normalized compatibility and capture metadata:

```sh
pnpm run validate:cases -- examples \
  --report reports/community-case-manifest.json
```

Validation reads JSON and file metadata only. It does not build or execute
project code. A valid report proves that the files and declared capture plan
are consistent; it does not prove Runtime compatibility.

## Capture

Build the package before capturing when `dist/server.js` is not current. Then
run one case:

```sh
pnpm run capture:case -- examples my-case \
  --output .tmp/case-artifacts/my-case \
  --report .tmp/case-artifacts/my-case.json
```

Use `--server path/to/server.js` to capture against an isolated build instead
of `dist/server.js`.

The capture command:

1. opens the case through the normal `example.json` discovery path;
2. builds the exact imported revision;
3. starts an isolated Runtime in headless Chrome;
4. applies the declared quality tier, warmup, and debug modes;
5. replays the capture plan in a fresh Runtime and compares frame SHA-256 digests;
6. writes PNG files and a contact sheet;
7. records Runtime metrics and teardown evidence.

`status: "passed"` means both Runtime runs completed, produced matching frame
digests, shut down without cleanup errors, and emitted no browser warnings or
errors. A successful capture does not replace case-specific interaction
assertions.

The repository-owned reference is
[`examples/runtime-contract`](../examples/runtime-contract). Its latest
focused evidence is
[`reports/m11-community-case-report.json`](../reports/m11-community-case-report.json).
