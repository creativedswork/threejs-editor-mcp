# Runtime Harness Architecture R4 Status

Updated: 2026-09-04T03:30:00+0800
Milestone: R4 Simplify Harness authority
State: `IMPLEMENTING_SLICES`
Gate: `AWAITING_ACCEPTANCE`
Next milestone: R5 Remove legacy paths and harden
Base: `f2570fcbc82594158d03b81db3df1bf6c32a5cdf`
Branch: `main`

## Scope

R4 replaces model-supplied Runtime routing coordinates with an owner-bound
opaque `runtimeRef`, gives each validation command an independent execution and
command-bound evidence token, makes active access depend on an Editor-issued
one-shot grant with a typed confirmation response, and routes App completion
through one typed idempotent broker settlement operation.

Exit criterion: ordinary validation tools cannot fail because the model copied
or invented revision, run ID, nonce, validation execution, or evidence-token
fields.

## Slice Ledger

| Slice | State | Commit | Owned scope |
|---|---|---|---|
| 1. Opaque Runtime reference | `COMMITTED` | `60f80f9` | Owner-bound `runtimeRef` issue/resolve/rotation, opaque model context, and preferred ordinary tool schemas; legacy identity remains internal compatibility only. |
| 2. Validation and active authority | `IMPLEMENTED` | pending | Independent validation execution, command-bound evidence token, typed active confirmation, and one-shot Editor grant consumption. |
| 3. Typed settlement and invariant matrix | `PENDING` | pending | One preferred typed idempotent settlement operation, legacy report/fail adapters, and focused broker/registry/protocol invariants. |

## Recovered Baseline

- Repository: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
- Branch: `main`
- HEAD and R3 acceptance closeout:
  `f2570fcbc82594158d03b81db3df1bf6c32a5cdf`.
- R3 implementation commits: `856a520`, `ed192d4`, `85edb8f`; R3 candidate
  documentation: `b852f9f`.
- Staged state: empty.
- No repository-local or parent `AGENTS.md` applies to this checkout.
- Relevant baseline SHA-256 values:
  - `src/workspaces.ts`:
    `0f06e6b411ec736c6b91315153c1107ecb8ba2cd2d23c8a8ad4ebb9bb66f35a8`
  - `src/server.ts`:
    `41f2fa9309d60da5059035968d8619a3c890b900211b76929a3b76e15d00671d`
  - `src/view.ts`:
    `4999dfafa6568c0b6ea36d00d0cb312a46eaa0d61ea49ac80c3451956c928853`
  - `src/m7-runtime.ts`:
    `15648962f2503ec48bfad3992fa401ffb968222dbc10c6f377c3d9f26793429f`
  - `tests/runtime-registry.test.mjs`:
    `67f21e68fb659c5ff8f8ad618d8619a3c890b900211b76929a3b76e15d00671d`
  - `tests/harness-tool-calls-browser.mjs`:
    `c05c85449f0027700a254d9960e0622570742ca588c580706c983a80a52a4dbc`
  - `tests/harness-tool-calls-page.mjs`:
    `edb06ef0b2988819317e970c468d2eb83ded807c687fb5207dd459f5c0e08eac`
  - `docs/specs/runtime-harness-architecture-audit.md`:
    `2906100342bbcfe7739cea26240fb45cdca3a5de630789ae4f58e1faf5e8bdc9`
- Relevant tracked files already contain mixed R4, M9, transport, lifecycle,
  and debug changes. Existing untracked debug notes, collectors, reports,
  fixtures, and Harness browser/page tests are preserved.
- `tests/fixtures/m6/workspace/world-model.html` and `world-model.png` appeared
  after the R4 baseline at 03:28. R4 commands wrote only `/tmp` bundle
  artifacts, no source or test references identify their producer, and their
  provenance is uncertain. They remain untracked, unstaged, and excluded.

## Explicit Exclusions

- R5 deletion of flat identity, legacy report/fail adapters, compatibility
  branches, temporary probes, hard-coded collectors, and source-regex tests.
- M9 implementation, tests, fixtures, reports, and evidence.
- Transport fixes, image resizing, hidden-frame scheduling, syntax validation,
  asset discovery, stdio serialization, and unrelated lifecycle changes.
- Existing changes to `docs/specs/editor-continuity.md`, `src/builder.ts`,
  browser tests, debug notes, `.dbg/`, reports, and fixture artifacts.
- Real browser runs, full suites, full typecheck, lint, production build,
  package checks, independent review, soak, push, amend, rebase, PR,
  deployment, and process or port cleanup.

## Release Hardening Ledger

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Exercise stale refs, owner-generation rollover, active grant expiry and
  consumption, validation startup failure, malformed evidence, cancellation,
  timeout, and conflicting duplicate settlement in real browser/Harness runs.
- Revalidate R4 after R5 removes compatibility RPCs and debug collectors.
- Run five browser lifecycle cycles and the 50-cycle Snow soak after all R
  milestones are accepted.

## EXECUTION_CHECKPOINT

- Updated at: 2026-09-04T03:30:00+0800
- Milestone: R4 Simplify Harness authority
- Slice: 2. Validation and active authority
- Phase: commit
- Slice state: `IMPLEMENTED`
- Completed facts: Slice 1 committed as `60f80f9`; model-facing Harness tools
  and Editor context use owner-bound opaque `runtimeRef`, refs rotate on
  registration and projection changes, and flat identity remains an internal
  compatibility adapter.
- Repository state: `main` at `60f80f9`; the index contains only Slice 2
  hunks in `src/workspaces.ts`, `src/server.ts`, `src/view.ts`, and
  `src/m7-runtime.ts`; mixed dirty and untracked paths remain present.
- Intended changes: reconcile only independent validation execution identity,
  per-command evidence tokens, command target binding, typed
  `ACTIVE_CONFIRMATION_REQUIRED`, and consumption of the existing Editor-issued
  one-shot active grant.
- Explicit exclusions: all items in Explicit Exclusions; especially no M9,
  debug-probe, transport, browser, R5 cleanup, process, port, or remote work.
- Verification: Slice 1 cached diff and exact-blob syntax bundles PASS.
  Slice 2 `git diff --cached --check` PASS; syntax-only Bun bundles of the
  exact cached `src/workspaces.ts`, `src/server.ts`, `src/view.ts`, and
  `src/m7-runtime.ts` blobs PASS. Slice 2 pre-edit SHA-256 values:
  `src/workspaces.ts`
  `0f06e6b411ec736c6b91315153c1107ecb8ba2cd2d23c8a8ad4ebb9bb66f35a8`;
  `src/server.ts`
  `eab35c998f005d7e0346676a23a1e6605f50d362b7e06060512b0487320db4cc`;
  `src/view.ts`
  `7b907df09fe28bc3f2fe54424578b67bd9661fcb0b530a739479d2a28494f69a`;
  `src/m7-runtime.ts`
  `15648962f2503ec48bfad3992fa401ffb968222dbc10c6f377c3d9f26793429f`.
  Post-edit values remained stable after more than five seconds; only
  `src/workspaces.ts` changed, to
  `2f10819ed2d0f92de0bdf5cd97c85527b5affcfcb145c23368f9429cb09ad8b4`.
- Evidence paths: this STATUS, the canonical plan/audit/R2/R3 STATUS files,
  and preserved debug/report artifacts already in the working tree.
- Run identity: N/A; R4 uses pure broker/registry/protocol checks and no live
  browser or external Runtime.
- Continuity constraints: preserve every unrelated dirty hunk; stage only
  exact R4 hunks; re-read and hash each target immediately before edits, then
  wait at least five seconds and verify the hash and target diff.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to separate an R4 hunk from
  excluded M9/debug work.
- Blockers and risks: mixed files require exact hunk staging; browser and full
  repository validation remain deferred to Release Hardening.
- Exact next action: stage this STATUS, verify the final cached diff, and
  create the local Slice 2 atomic commit.
- Stop condition: all three Slices committed, concentrated isolated-HEAD R4
  self-test recorded, docs-only candidate committed, then stop at
  `MILESTONE_CANDIDATE` / `AWAITING_ACCEPTANCE`.
