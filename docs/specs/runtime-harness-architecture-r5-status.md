# Runtime Harness Architecture R5 Status

Updated: 2026-09-04T05:48:06+0800
Milestone: R5 Remove legacy paths and harden
State: `IMPLEMENTING_SLICES`
Gate: `AUTHORIZED`
Next phase: Release Hardening approval
Base: `c9c4933`
Branch: `main`

## Authorization

The user authorized completing all remaining R milestones before one final
report. R5 stops at `MILESTONE_CANDIDATE` / `AWAITING_ACCEPTANCE`; it does not
resume M9 or enter Release Hardening.

## Scope

R5 removes lifecycle compatibility paths superseded by R1-R4:

1. server and registry flat-identity registration/routing, report/fail broker
   adapters, and duplicate broker state;
2. client and Runtime compatibility routing plus clearly marked temporary
   production collectors and probe tools;
3. source-regex and legacy-path tests, replacing them with focused behavioral
   and state-machine invariants.

Exit requires one identity model, one coordinator, one registry aggregate, one
broker state machine, and no active legacy lifecycle path.

## Slice Ledger

| Slice | State | Commit | Owned scope |
|---|---|---|---|
| 1. Server/registry legacy removal | `COMMITTED_LOCAL` | `b689567` | `src/runtime-protocol.ts`, exact R5 hunks in `src/server.ts`, `src/workspaces.ts`, and required client contract hunks in `src/view.ts`; this STATUS |
| 2. Client/Runtime probe removal | `IMPLEMENTED` | pending | Removed temporary production collectors and probe tools from `src/view.ts`, `src/m7-runtime.ts`, `src/server.ts`, and `src/workspaces.ts`; preserved all historical evidence artifacts. |
| 3. Behavioral invariant cleanup | `PENDING` | pending | Source-regex/legacy assertions replaced or removed in focused test files |

## Recovered Baseline

- Repository:
  `/Users/bytedanceo/Workspace/DeepSeekSpace/threejs-editor-mcp`
- Branch: `main`
- HEAD and accepted R4 closeout: `c9c4933`
- R4 commits: `60f80f9`, `c791edd`, `ed6cb2b`, `fb984fd`, candidate
  `b4f284d`, and acceptance closeout `c9c4933`.
- Index: empty.
- The worktree contains unrelated M9, transport, debug-evidence, browser-test,
  Harness-test, and uncertain M6 fixture changes.
- Relevant pre-edit SHA-256 values:
  - `src/server.ts`:
    `c58aef628ffe2998bd2cfbe336aefe74035b109642dca4839780b03738971132`
  - `src/workspaces.ts`:
    `7b37895e8d02f1d64a5904339945ff302127d382db33398a47fd9e999cf1633c`
  - `src/view.ts`:
    `5c9a854d9611d1ac3ab30274dfba40c0b57b7c2aafa2472d532c4336b6bd6878`
  - `src/m7-runtime.ts`:
    `15648962f2503ec48bfad3992fa401ffb968222dbc10c6f377c3d9f26793429f`
  - `tests/runtime-registry.test.mjs`:
    `f34ebf3218f23ab23a96e1cf8e36959df28240e65c64406931f94fae3ec4f23c`
  - `tests/runtime-protocol.test.mjs`:
    `19b1d668555030a92423cb80002bc45152c138028702cb9d9d2fec3cbbaec940`
  - `tests/runtime-lifecycle.test.mjs`:
    `473df9d320509d665d3a7b226e2443887162b7f44fcf7268938cd9a654fd6b06`
- No repository-local or parent `AGENTS.md` applies to this checkout.

## Explicit Exclusions

- All unrelated M9 implementation, tests, fixtures, reports, and evidence.
- Transport fixes, image resizing, hidden-frame scheduling, syntax validation,
  asset discovery, stdio serialization, and unrelated lifecycle fixes.
- `.dbg/`, every `debug-*.md`, reports, screenshots, logs, and historical
  evidence artifacts.
- Untracked Harness browser/page tests unless an exact R5 test replacement is
  proven necessary.
- Uncertain M6 fixture outputs.
- Full Node/browser suites, full typecheck, lint, production/package checks,
  independent review, five-cycle browser CI, and the 50-cycle Snow soak.
- Process or port cleanup, M9 work, push, amend, rebase, PR, and deployment.

## Release Hardening Ledger

- Run the full Node and browser suites, repository typecheck, lint, production
  build, package checks, and independent cumulative review.
- Exercise transition fault injection and reconnect behavior in a real
  browser/Harness run.
- Run five browser lifecycle cycles and the 50-cycle Snow soak.
- Revalidate M9 and all accepted R milestones together after R5 acceptance.

## EXECUTION_CHECKPOINT

- Updated at: 2026-09-04T05:48:06+0800
- Milestone: R5 Remove legacy paths and harden
- Slice: 2. Client/Runtime probe removal
- Phase: commit
- Slice state: `IMPLEMENTED`
- Completed facts: Slice 1 committed as `b689567` after its exact indexed
  snapshot passed TypeScript. Production source contains no temporary
  collector URL, debug probe event, or debug-only App tool; retained `.dbg`,
  debug notes, reports, logs, screenshots, and browser evidence were not
  changed.
- Repository state: `main` at `b689567`; index empty; relevant dirty files are
  `src/server.ts`, `src/workspaces.ts`, `src/view.ts`, and
  `src/m7-runtime.ts`; unrelated dirty and untracked paths remain excluded.
- Intended changes: commit only this STATUS update because the probes were
  uncommitted instrumentation; removing them produces no source delta against
  the committed Slice 1 candidate.
- Explicit exclusions: all items in Explicit Exclusions; preserve every
  unrelated dirty hunk and evidence artifact.
- Verification: exact indexed Slice 1 snapshot
  `pnpm exec tsc --noEmit --pretty false` PASS; source search for collector
  URLs, debug probe events, and debug-only App tools PASS at `b689567` and in
  the current worktree.
- Evidence paths: this STATUS and the accepted R2/R3/R4 STATUS files.
- Run identity: N/A; R5 uses pure focused checks and no live browser Runtime.
- Continuity constraints: edit latest disk content; hash every mixed target
  before editing; wait at least five seconds and recheck hashes/diffs; stage
  exact hunks only.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to prove an obsolete hunk from
  the audit or call graph.
- Blockers and risks: compatibility tests may encode obsolete behavior and
  must be replaced by current state-machine invariants without broad test
  expansion.
- Exact next action: commit this Slice 2 STATUS update, then replace legacy and
  source-regex tests with focused normalized-state invariants.
- Stop condition: R5 candidate report at `AWAITING_ACCEPTANCE`, or an ownership
  ambiguity that prevents exact-hunk staging.
