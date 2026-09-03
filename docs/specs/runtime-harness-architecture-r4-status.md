# Runtime Harness Architecture R4 Status

Updated: 2026-09-04T05:10:27+0800
Milestone: R4 Simplify Harness authority
State: `ACCEPTED`
Gate: `ACCEPTED`
Next milestone: R5 Remove legacy paths and harden
Base: `f2570fcbc82594158d03b81db3df1bf6c32a5cdf`
Branch: `main`

## Acceptance Decision

On 2026-09-04, the user explicitly accepted the R4 candidate and authorized
continuous execution of the remaining R milestones before the next report.

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
| 2. Validation and active authority | `COMMITTED` | `c791edd` | Independent validation execution, command-bound evidence token, typed active confirmation, and one-shot Editor grant consumption. |
| 3. Typed settlement and invariant matrix | `COMMITTED` | `ed6cb2b`, `fb984fd` | One preferred typed idempotent settlement operation, legacy report/fail adapters, and focused broker/registry/protocol invariants. |

## Recovered Baseline

- Repository: `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
- Branch: `main`
- HEAD and R3 acceptance closeout:
  `f2570fcbc82594158d03b81db3df1bf6c32a5cdf`.
- R3 implementation commits: `856a520`, `ed192d4`, `85edb8f`; R3 candidate
  documentation: `b852f9f`.
- Recovery verified `main` at
  `fb984fdef0fabb036c390a41f87cfaddefbf35f5`, with direct R4 ancestry
  `60f80f9` -> `c791edd` -> `ed6cb2b` -> `fb984fd`.
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
- `tests/fixtures/m6/workspace/world-model.html`, `world-model.png`, and
  `world-model-canvas/` appeared after the R4 baseline between 03:28 and
  03:32. R4 commands wrote only `/tmp` bundle artifacts, no source or test
  references identify their producer, and their provenance is uncertain.
  They remain untracked, unstaged, and excluded.

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

## Milestone Self-Test

- Source under test: committed HEAD
  `fb984fdef0fabb036c390a41f87cfaddefbf35f5`, exported to an isolated
  temporary snapshot so excluded working-tree changes could not affect the
  result.
- Focused server build:
  `pnpm exec tsdown --config tsdown.config.ts --filter threejs-editor-mcp/server`
  passed; `tsdown` reported a 105 ms build.
- Concentrated test used `node --test` with an anchored alternation of
  `prepared Runtime runs expire and commit with active-run CAS`,
  `Runtime projection advances only after acknowledgement and recovers by
  replacement`, and
  `formats every typed terminal outcome deterministically for replay` against
  `tests/runtime-registry.test.mjs` and `tests/runtime-protocol.test.mjs`; it
  passed `3/3` in 17.9 seconds.
- The selected cases prove opaque refs and command-bound evidence route
  validation without model-supplied coordinates, active access requires and
  consumes an Editor grant, identical settlement is idempotent while a
  conflicting duplicate is rejected, refs rotate with projection/owner
  changes, projection recovery remains valid, and typed terminal outcomes are
  deterministic.
- An initial selector also included two unchanged legacy M8.1 compatibility
  cases. They failed on stale flat-identity expectations. Their working-tree
  updates predate this closeout and are explicitly excluded, so no R4 source or
  test fix was made and the canonical selector was rerun at its committed
  boundary.
- Functional implementation took tens of minutes; the canonical focused build
  and concentrated self-test took under one minute.

## Acceptance

1. Review commits `60f80f9`, `c791edd`, `ed6cb2b`, and `fb984fd`.
2. Confirm the isolated focused server build and three named R4 tests pass.
3. Confirm ordinary validation tools use the latest owner-bound `runtimeRef`
   rather than model-supplied revision, run ID, nonce, or evidence token.
4. Confirm validation commands receive independent execution identity and a
   command-bound evidence token.
5. Confirm active access returns typed confirmation until an Editor-issued
   one-shot grant is consumed.
6. Confirm exact duplicate settlement replays successfully while a conflicting
   duplicate is rejected with typed command state.

Expected result: ordinary validation does not depend on copied or invented
internal routing coordinates, and every broker command has one deterministic
terminal outcome. Failure is acceptance of a foreign/stale ref, active access
without an Editor grant, reuse of registration evidence for a validation
command, or conflicting settlement accepted as idempotent.

## EXECUTION_CHECKPOINT (CLOSED)

- Updated at: 2026-09-04T05:10:27+0800
- Milestone: R4 Simplify Harness authority
- Slice: all Slices
- Phase: acceptance-closeout
- Slice state: `COMMITTED_LOCAL`
- Completed facts: Slice 1 committed as `60f80f9`; Slice 2 committed as
  `c791edd`; Slice 3 production committed as `ed6cb2b`; Slice 3 focused test
  alignment committed as `fb984fd`. Opaque references, independent validation
  identity, command-bound evidence, one-shot active authorization, and typed
  idempotent settlement are committed. The user explicitly accepted R4 on
  2026-09-04 and authorized completion of the remaining R milestones before
  the next report.
- Repository state: `main`; candidate implementation is
  `fb984fdef0fabb036c390a41f87cfaddefbf35f5`; candidate documentation is
  `b4f284d`; the index was empty before this final STATUS update. The mixed
  dirty and untracked paths listed in Recovered Baseline remain present.
- Intended changes: none; R4 implementation and focused verification are
  complete.
- Explicit exclusions: all items in Explicit Exclusions; especially no M9,
  debug-probe, transport, browser, R5 cleanup, process, port, or remote work.
- Verification: exact commits and direct ancestry verified; index verified
  empty. Slice 1 and Slice 2 cached diff and exact-blob syntax bundles PASS.
  Slice 3 commit reread verified the production scope in `ed6cb2b` and focused
  registry test alignment in `fb984fd`. The isolated focused server build
  PASS. An initial over-broad selector passed the three committed R4
  registry/protocol cases but failed two legacy M8.1 compatibility cases whose
  stale flat-identity expectations were not changed by any R4 commit and whose
  working-tree updates are explicitly excluded dirty work. No file was
  changed in response. The canonical isolated committed-HEAD selector passed
  all three selected R4 cases in 17.9 seconds.
- Evidence paths: this STATUS, the canonical plan/audit/R2/R3 STATUS files,
  and preserved debug/report artifacts already in the working tree.
- Run identity: N/A; R4 uses pure broker/registry/protocol checks and no live
  browser or external Runtime.
- Continuity constraints: preserve every unrelated dirty hunk and untracked
  artifact; stage only this STATUS and the master-plan acceptance hunks for
  closeout.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to separate an R4 hunk from
  excluded M9/debug work.
- Blockers and risks: no R4 blocker. The unchanged legacy M8.1 compatibility
  tests still need their already-dirty opaque-ref alignment reconciled outside
  this isolated closeout. Browser and full repository validation remain
  deferred to Release Hardening.
- Exact next action: close the R4 acceptance Owner; R5 is the next/current
  milestone and requires a new independent Owner.
- Stop condition: create the docs-only R4 acceptance commit without starting
  R5 or performing any remote operation.
