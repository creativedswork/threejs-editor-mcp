# Runtime Harness Architecture R5 Status

Updated: 2026-09-04T05:53:22+0800
Milestone: R5 Remove legacy paths and harden
State: `ACCEPTED`
Gate: `ACCEPTED`
Next phase: M9 Milestone self-test, not started
Base: `c9c4933`
Branch: `main`

## Authorization

The user authorized completing and accepting all remaining R milestones before
one final report. The authorization does not resume M9 or enter Release
Hardening.

## Acceptance Decision

On 2026-09-04, the standing user authorization accepted the R5 candidate after
its Slice commits, focused self-test evidence, exclusions, and deferred
Release Hardening work were recorded. This closes R0-R5 without starting M9,
M10, M11, or Release Hardening.

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
| 2. Client/Runtime probe removal | `COMMITTED_LOCAL` | `cbb694f` | Removed temporary production collectors and probe tools from `src/view.ts`, `src/m7-runtime.ts`, `src/server.ts`, and `src/workspaces.ts`; preserved all historical evidence artifacts. |
| 3. Behavioral invariant cleanup | `COMMITTED_LOCAL` | `60b88f7` | Replaced legacy adapter and flat-RPC assertions with normalized protocol, registry, broker, and tool-inventory behavior in focused tests. |

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

## Milestone Self-Test

- Source under test: committed implementation HEAD `60b88f7`, exported to an
  isolated tracked-file snapshot so excluded worktree changes could not affect
  the result.
- Focused server build:
  `pnpm exec tsdown --config <isolated>/tsdown.config.ts --filter threejs-editor-mcp/server`
  passed in 97 ms.
- One concentrated `node --test` invocation selected
  `compares normalized execution and projection as one Runtime identity` and
  `normalized Runtime registry and broker preserve identity invariants` from
  `tests/runtime-protocol.test.mjs` and
  `tests/runtime-registry.test.mjs`.
- Result: `2/2` passed, `0` failed, in 7.19 seconds.
- The selected behavior proves normalized identity equality, owner-bound opaque
  Runtime references, independent validation execution, one command-state map,
  idempotent matching settlement, conflicting-settlement rejection, pending
  projection binding, projection generation advance, and stale-reference
  rejection.
- Functional implementation and exact staging took tens of minutes; the
  focused build and self-test took under 30 seconds.

## Acceptance

1. Review Slice commits `b689567`, `cbb694f`, and `60b88f7`.
2. Confirm production source exposes no flat registration, report/fail broker
   adapter, debug-only App tool, hard-coded collector, or duplicate registry
   and settled-command map.
3. Confirm Runtime preparation, commit, command execution, settlement, and
   projection use normalized execution/projection identities internally and
   opaque `runtimeRef` addresses at the App boundary.
4. Confirm the isolated focused build and two selected behavior tests pass.

Expected result: one identity model, one client coordinator, one owner-scoped
registry aggregate, one broker state machine, and no active legacy lifecycle
path. Failure is any retained production compatibility route, foreign/stale
reference acceptance, duplicate mutable owner, or conflicting settlement
accepted as idempotent.

## EXECUTION_CHECKPOINT

- Updated at: 2026-09-04T05:53:22+0800
- Milestone: R5 Remove legacy paths and harden
- Slice: all Slices
- Phase: acceptance-closeout
- Slice state: `COMMITTED_LOCAL`
- Completed facts: Slice 1 committed as `b689567`; Slice 2 cleanup was recorded
  as `cbb694f`; Slice 3 committed as `60b88f7`. The exact committed candidate
  passed the focused server build and two selected normalized protocol/registry
  behavior tests.
- Repository state: `main`; implementation HEAD `60b88f7`; candidate
  documentation `5dcfd4f`; index empty before this acceptance closeout.
  Relevant dirty files are `src/server.ts`, `src/workspaces.ts`, `src/view.ts`,
  and `src/m7-runtime.ts`; unrelated dirty and untracked paths remain excluded.
- Intended changes: commit only this acceptance STATUS and the master-plan
  R0-R5 state update.
- Explicit exclusions: all items in Explicit Exclusions; preserve every
  unrelated dirty hunk and evidence artifact.
- Verification: exact Slice 1 indexed TypeScript PASS; Slice 3 syntax checks
  PASS; committed candidate focused server build PASS; concentrated behavior
  test PASS `2/2` in 7.19 seconds.
- Evidence paths: this STATUS and the accepted R2/R3/R4 STATUS files.
- Run identity: N/A; R5 uses pure focused checks and no live browser Runtime.
- Continuity constraints: edit latest disk content; hash every mixed target
  before editing; wait at least five seconds and recheck hashes/diffs; stage
  exact hunks only.
- Invalidators: branch or HEAD change, unknown staged content, target hash
  change outside an owned patch, or inability to prove an obsolete hunk from
  the audit or call graph.
- Blockers and risks: no R5 functional blocker. Broader M6/M7/M8.1/M9 tests
  still contain or carry dirty compatibility migrations and remain deferred
  with full suites, browser cycles, fault injection, review, and soak to
  Release Hardening.
- Exact next action: close the R5 Owner and stop. M9, M10, M11, Release
  Hardening, and all remote operations require a later explicit action.
- Stop condition: R5 acceptance closeout committed locally; no next milestone
  or hardening work starts in this run.
- Stop condition: R5 candidate report at `AWAITING_ACCEPTANCE`, or an ownership
  ambiguity that prevents exact-hunk staging.
