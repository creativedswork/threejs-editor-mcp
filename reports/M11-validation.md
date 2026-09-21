# M11 Validation

Status: **RELEASE_HARDENING**

## Execution checkpoint

EXECUTION_CHECKPOINT
- Updated at: 2026-09-21 21:25:16 +0800
- Milestone: M11 - community contract and 0.2.0 release
- Slice: packed 0.2.0 candidate
- Phase: release-hardening
- Slice state: IMPLEMENTING
- Completed facts: The user accepted the compatibility and error-propagation audit on 2026-09-21, authorized M11 implementation, and approved Release Hardening plus commit, push, PR, and npm publication. Runtime modules, build identifiers, diagnostics, and user-visible Runtime messages now use responsibility-based names while retaining existing wire identifiers and E2E compatibility aliases. The public `Threejs-editor-mcp-showcase` video supplied the six-panel Runtime cover at timestamp 00:07. The community case validator, capture runner, owned Runtime fixture, format guide, contributor guide, security guide, dependency profile guide, and V1/V2 migration guide are implemented. Package and README versions are prepared as `0.2.0`, and `CHANGELOG.md` records the candidate scope. Fixed debug collectors were removed from both release repositories.
- Repository state: `threejs-editor-mcp`, branch `main`, HEAD `75f96e3`. No staged files. The checkout contains unrelated tracked and untracked debugging work.
- Intended changes: Run cumulative tests and reviews, make both READMEs release-oriented, build and inspect the production package, install it into a fresh Harness profile, run the complete G1 workflow, commit and push the owned changes in `threejs-editor-mcp` and `dsh-uni-editor`, open both pull requests, and publish `threejs-editor-mcp@0.2.0`. `tests/m10-real-model-browser.mjs` now preserves an explicitly supplied packed Server path.
- Explicit exclusions: Do not redesign Runtime ownership, add a third Runtime abstraction, rewrite historical reports, change compatible wire identifiers, include unrelated debug files, publish `dsh-uni-editor`, modify YouTube metadata, or prepare X/Xiaohongshu copy before npm publication succeeds.
- Verification: `threejs-editor-mcp` final `release:check` PASS: upstream sync, typecheck, production build, 88/88 tests, tarball install, installed CLI and MCP smoke. The inspected tarball contains 34 files, including the versioned README cover, community scripts, owned example, and report. `dsh-uni-editor` `check` PASS with 28 passed and one external-artifact test skipped; `pack:dry-run` PASS with 17 files. Strict case capture status is `passed` with stable hashes, no browser problems, and complete teardown. Fresh packed G1 PASS with a normal configured provider, real `open_editor` and `build_project` calls, gameplay movement, running audio, skeleton debug mode, Runtime evidence, and `browserProblems: []`.
- Evidence paths: `reports/assets/m11-six-runtime-cover.png`, `reports/m11-community-case-report.json`, `reports/assets/m11-runtime-contract/`, `.tmp/m11-fresh-g1-packed/M10-real-model-result.json`, `.tmp/m11-fresh-g1-packed/host.log`, `.playwright-mcp/m11-fresh-g1-packed/`, and focused test files listed below.
- Run identity: Strict capture run `e203fa0a-8610-4ec8-91f8-926db6d6ebd5` is closed. Fresh G1 model session `session-e604fe56-2003-4969-82a6-292ddd0ad3ff`, project `workspace-04be30c6317524a3906788f8c07acef0f490ceceb8661d1b4b6959`, build `520fa609c95d0d0c32d1715276fa39bd57585edc9ff06dcba5f0108ee28e5fdf`, and Runtime evidence digest `4d25e16efd4485aa8a7173eb2395346a8d1ac9569ec4830a1a50b7813f845509`; all isolated processes are closed.
- Resource ownership: This Agent owns the accepted compatibility hunks, M11 Runtime naming changes, media assets, case-contract changes, and this report. Existing `3080` processes, browser Session state, and other dirty files remain externally owned. Temporary port `7781` is closed.
- Active command: N/A. Fresh packed G1 completed and cleaned its isolated Host, browser, and MCP Server processes.
- Continuity constraints: Preserve all unrelated dirty hunks. Do not change `dist/` while the externally owned Server remains active. Do not describe version metadata or an isolated bundle as a packed-install or release result.
- Invalidators: Concurrent edits to owned hunks, HEAD or branch changes, staged files from another task, or a rebuild/restart of the existing `3080` Three.js MCP child.
- Blockers and risks: PR GIF, security review, and cumulative code review remain pending. Unrelated dirty files must stay outside the release commits. The copied user profile was rejected as Fresh Harness evidence because unrelated bundles affected Host startup.
- Exact next action: Classify the release-owned diff in both repositories, create release branches, and make local candidate commits without staging unrelated debugging files.
- Stop condition: A confirmed release blocker, missing publication credential, remote conflict that cannot be resolved without rewriting unowned history, or successful npm publication and promotion-copy handoff.

## Slice ledger

| Slice | State | Result |
| --- | --- | --- |
| Compatibility and error propagation | ACCEPTED | User accepted on 2026-09-21; C1-C5 remain covered by focused evidence below. |
| Release-surface formalization | IMPLEMENTED | Production modules now use `runtime-isolation-fixture.ts` and `workspace-runtime.ts`; wire identifiers remain compatible. |
| Six-panel video cover | IMPLEMENTED | README cover extracted from the approved public video at 00:07 and linked to the new video. |
| Community case contract | IMPLEMENTED | Recursive validator and capture CLI reuse `example.json`; the owned C1 fixture produced deterministic frame and contact-sheet evidence. |
| Guides and migration | IMPLEMENTED | Added contributor, security, dependency profile, community case, and V1/V2 migration documentation linked from both READMEs. |
| Packed 0.2.0 candidate | PENDING | Version and changelog are prepared; production pack, fresh install, complete Harness E2E, and package-content evidence await Release Hardening approval. |

## Audit scope

| Area | Question | Status |
| --- | --- | --- |
| Persisted metadata | Can data from an older version block startup even when it is safe to regenerate? | Passed |
| Error propagation | Can a useful exception become empty, truncated, or misleading before reaching the UI or Agent? | Passed |
| Status semantics | Can static checks be presented as proof that Runtime or App loading succeeded? | Passed |
| Runtime cleanup | Can stale ownership or evidence records block a new run or cleanup? | Passed |

## Confirmed findings

| ID | Failure | Resolution |
| --- | --- | --- |
| C1 | Legacy or malformed disposable metadata could block build, inspection, diagnostics, Runtime commit, or cleanup. | Invalid `build.json`, `runtime.json`, editor-scene evidence, and `active-run.json` are treated as absent and regenerated. File ownership and path checks still fail closed. |
| C2 | Six UI status paths kept only the first error line, reducing structured errors to text such as `Error: [`. | All concise UI/model statuses use one summary function; complete Runtime diagnostics remain unchanged. |
| C3 | `check_project` could report zero errors without clearly separating source/build checks from missing or stale Runtime evidence. | The result now includes `runtimeStatus: not-reported | stale | current`; missing and stale evidence are explicitly inconclusive. |
| C4 | One malformed `example.json` aborted discovery of every example in the Workspace. | Discovery returns that example as unavailable with a bounded issue while preserving other candidates. |
| C5 | Builder aliases used through native `HTMLImageElement.src` bypassed `THREE.DefaultLoadingManager`, so valid images could fail to decode. | The isolated Runtime resolves native image `src` assignments through the same revision-bound asset map and restores the original setter during teardown. |

## Persisted data classification

| Class | Files | Behavior |
| --- | --- | --- |
| Authoritative state | `project.json`, `.threejs-editor/project.json`, `source.json`, revision manifests, transactions, source objects, `threejs.editor.json` | Invalid content still fails closed. These files define project content, identity, recovery, or user edits. |
| Regenerable metadata | `builds/*/build.json`, `diagnostics/runtime.json`, `editor-scenes/*.json`, `diagnostics/active-run.json`, scene-project `diagnostics.json` | Invalid or older schemas are treated as absent. The build or Runtime can regenerate them without changing project content. |
| Discovery input | `example.json` | A malformed file disables only its own example and reports the parse failure. Other examples remain discoverable. |
| Browser-local draft | `localStorage` Workspace draft | Invalid data is ignored as an optional draft; persisted project state remains authoritative. |

The compatibility parser runs only after metadata path, regular-file, symlink, hardlink,
and ownership checks. Compatibility handling therefore does not weaken the filesystem
boundary.

## Focused verification

Compatibility tests used `.tmp/m11-compat-candidate/server.js`. The Meadow
reproduction reused `dist/server.js` for its unchanged build endpoint and imported
the current `src/workspace-runtime.ts` bootstrap directly. The existing server on
`127.0.0.1:3080` was not restarted.

| Check | Result | Evidence |
| --- | --- | --- |
| Runtime registry compatibility | PASS | `tests/runtime-registry.test.mjs`: 1 test passed; invalid `build.json`, legacy `active-run.json`, Runtime diagnostics, and editor-scene evidence did not block a new run. |
| Discovery and status compatibility | PASS | `tests/workspace-compatibility.test.mjs`: 2 tests passed; malformed `example.json` was isolated and `runtimeStatus` covered `not-reported`, `current`, and `stale`. |
| Metadata filesystem boundary | PASS | `tests/m7-builder.test.mjs` filtered to `M8 rejects symlinked Runtime metadata files`: 1 test passed. |
| Interactive Pool Volume | PASS | Current corpus revision `ab47935c773f30a90b11e13737e239e5349adfadf4f75ef2c5eb84470098465e`, build `01fe6e6bfa63e5b15c6d543bb5d500f90f346efd3d6f76b8c6ce596b31274308`, Runtime frame `1`, 524 sampled colors, 695/2400 lit samples, no browser errors. |
| Ash Growth and App failure feedback | PASS | Revision `abda8db24c6453b2a7810f69842da7877c8fd3b2abc3f9375a9b752161f732b9`, all 3 Draco decoder assets, 1541 sampled colors, 2400/2400 lit samples. Synthetic multi-line failure produced `execution: Invalid input: expected object, received undefined` and one Session message. |
| Native image asset decoding | PASS | Chrome decoded all 13 PNG/WebP source assets through both `Image.decode()` and `createImageBitmap()`, ruling out corrupt files. The focused resolver test passed and confirmed teardown restores the original `src` setter. |
| Stylized Meadow Grass | PASS | Revision `87f086310586fe2b710c2851a2e35ba990d3a6e749346c8306c794d181a9337a`, build `ef356b6f775c978478703cf40055cfae198ffc124ff2c6c8859cbfa813b9c3ca`, 11 Runtime assets, Runtime frame `1`, 2238 sampled colors, 2400/2400 lit samples, no browser errors. |
| Community case validation | PASS | `tests/case-contract.test.mjs`: 2 tests passed; recursive discovery normalized the owned fixture and rejected an unknown capture mode before code execution. |
| Runtime contract capture | PASS | Revision `5772d24e7a8f125b2e5799d5f87b660ee2ca33fddf9820e41bd672b5b1282c42`, build `7e8f63bc37b18ca94d5efd2029a50a81e72f71b384a9dcb1274210b5b59e7d87`; strict run `e203fa0a-8610-4ec8-91f8-926db6d6ebd5` matched frame digests `594bffa7...` and `9e302603...`, reported no browser problems, and teardown retained no Runtime-owned resources. The contact sheet was visually reviewed. |
| Release-surface bundle | PASS | An isolated tsdown build emitted `server.js` and `view.js` with `workspace-loader-profile-v1`, `pinned runtime profile`, `data-phase="workspace"`, Workspace Runtime messages, and Runtime isolation fixture messages. |
| Candidate metadata | PASS | `package.json` reports `threejs-editor-mcp@0.2.0`; both READMEs and `CHANGELOG.md` use the same candidate version. |

## Accepted compatibility criteria

The user accepted this Slice on 2026-09-21. Its criteria covered:

- Stylized Meadow Grass reaching Runtime ready without an image decode failure;
- Interactive Pool Volume opening without legacy `active-run.json` blocking startup;
- complete Agent-visible failure summaries instead of `Error: [`;
- `check_project` keeping missing or stale Runtime evidence inconclusive; and
- malformed example metadata not hiding valid examples.

## Deferred to Release Hardening

- full repository tests, typecheck, lint, production build, packed install, and release checks;
- cumulative code review of all M11 changes;
- repeated browser runs and the complete external corpus matrix;
- final verification that only release-owned files enter each commit.

No files are staged. No commit, push, PR, service restart, or publication was performed.
