# Runtime Harness Architecture Audit

Status: Proposed remediation plan
Scope: Runtime lifecycle, revision projection, Runtime Harness, and evidence
Date: 2026-09-02

## Executive Conclusion

The recurring failures are not one bug. They are repeated symptoms of one
incomplete migration: M1 and M2 added serialization and candidate promotion,
but Phase 3 authoritative revision projection and Phase 4 legacy-state removal
remain unfinished. Runtime Harness was then added on top of that hybrid model.

The current protocol cannot represent its real post-rollover state without a
contradiction:

- one mounted iframe keeps the same process, run ID, nonce, and loaded build;
- an Editor-only mutation advances the Workspace and applied scene revision;
- a validation iframe is a different execution using a build for the new
  revision;
- both executions are nevertheless described with one `RuntimeIdentity`, one
  active evidence token, and one active registry record.

Recent target-specific build checks are correct compatibility fixes, but more
branches on the current identity object will not make the model coherent. The
next milestone should normalize identity and ownership before adding more
Harness features.

## Incident Taxonomy

| Incident family | Immediate symptom | Structural cause |
|---|---|---|
| Play/Stop restore and candidate readiness | early ready, restore failure, transient blank state | lifecycle phase moved into a controller while committed Runtime resources remained mutable globals |
| Generated or stale run identity | model invents or reuses `runId`/`nonce` | model-visible tools expose internal routing coordinates instead of an opaque capability |
| Harness timeout and abandoned lease | preparation, execution, evidence reporting, and settlement collapse into timeout | broker state and terminal outcomes are implicit across several RPCs and timers |
| Active authorization retries | model self-asserts `activeIntent` | intent hint and actual Editor authority are represented as unrelated mechanisms |
| Rollover evidence rejection | correct new revision is rejected as stale/foreign | stable execution identity, mutable projection revision, and build provenance share one flat identity |
| PNG size, iframe timer throttling, stdio backpressure | payload overflow or delayed completion | transport and browser scheduling limits; real defects, but independent of Runtime identity design |

The first five families share the same state-model problem. The last family
must stay separately classified so transport fixes do not obscure lifecycle
failures.

## Implementation Evidence

- `src/workspaces.ts:193-204` stores revision, optional build, execution,
  evidence, owner, and process fields in one `ActiveRuntime`.
- `src/workspaces.ts:298-303` defines revision as part of
  `RuntimeIdentity`.
- `src/view.ts:152-163` duplicates that flat identity in `M7Run`, while
  `CommittedRuntime` omits build, token, frame, candidate, and validation
  state.
- `src/view.ts:2635-2646` needs separate equality for execution and
  revision-bound run state.
- `src/view.ts:2883-2888` gives the validation iframe the active run identity
  and evidence token.
- `src/view.ts:3988-4063` advances Server registration before iframe
  acknowledgement and browser-state publication.
- `src/view.ts:4077-4108` compensates for failed rollover with synthesized
  iframe and Server identities.
- `src/workspaces.ts:386-399` models broker and grant state in separate
  records, and `src/workspaces.ts:1788` labels every explicit failure as
  preparation failure.
- `src/builder.ts:125-133` includes the complete Workspace revision in
  `buildId`.
- `docs/specs/runtime-lifecycle-recovery-m2-status.md:17-18` explicitly
  excludes authoritative Save, legacy-state removal, and full hardening.

## Foundations To Keep

- Immutable Workspace revisions and the per-project transaction lock.
- Candidate Runtime prepare/commit with active-run CAS.
- Session plus connection-generation ownership.
- Last-good visible Runtime preservation until candidate promotion.
- Post-commit isolation for model context and diagnostics.
- Bounded Runtime evidence and one-shot active grants.

The redesign should tighten ownership and identities around these mechanisms,
not replace the builder, iframe Runtime, MCP transport, or Workspace store.

## Findings

### 1. `RuntimeIdentity` is not an identity

`RuntimeIdentity` is `projectId + revision + runId + nonce`, but the same
mounted execution deliberately keeps `runId` and `nonce` while changing
`revision`. The client already needs two equality functions:

- `sameM7Runtime`: ignores revision;
- `sameM7Run`: includes revision.

That is evidence that one type represents two concepts. A revision rollover
then preserves the old active build while assigning the new Workspace
revision. The resulting record is operationally valid but cannot be explained
as one immutable identity.

Required split:

```ts
interface ExecutionId {
  projectId: string
  runId: string
  nonce: string
  owner: RuntimeOwner
}

interface RuntimeProjection {
  workspaceRevision: string
  generation: number
  loadedBuild: {
    buildId: string
    sourceRevision: string
  }
}
```

`ExecutionId` is stable for the iframe lifetime. `RuntimeProjection` changes
only through an acknowledged transition.

### 2. Active and validation executions impersonate each other

The isolated validation iframe copies the active `projectId`, `revision`,
`runId`, and `nonce`, and normally reuses the active evidence token. It is a
different browser execution with a potentially different build, but the
protocol identifies it as the active execution plus `target: validation`.

This caused the rollover build regression directly. It also makes evidence
provenance depend on target-specific exceptions rather than a unique execution
and command binding.

Validation needs its own internal execution ID. A command should carry an
anchor to the active projection requested by the caller and a server-selected
target execution. The model does not need to know the validation execution ID.

### 3. The transition controller is not the aggregate owner

`RuntimeTransitionController` owns phase, epoch, cancellation, and a small
`CommittedRuntime` value. It does not own the resources that define the
committed Runtime: active run, frame, build, evidence token, validation run,
bundle, scene report, and cleanup state remain independent mutable values in
`src/view.ts`.

The controller therefore serializes entry points but cannot enforce an atomic
state replacement. Code can observe a new phase with old resources or update
resources before the controller commits its snapshot.

The client needs one coordinator-owned aggregate:

```ts
interface CommittedRuntime {
  execution: ExecutionId
  projection: RuntimeProjection
  frame: HTMLIFrameElement
  evidenceToken: string
  mode: 'edit' | 'run'
}

interface RuntimeCoordinatorState {
  phase: RuntimePhase
  epoch: number
  active?: CommittedRuntime
  candidate?: PreparedRuntime
  validation?: ValidationRuntime
}
```

Only coordinator commit methods may replace these fields. UI and model context
must derive from one immutable snapshot.

### 4. Revision rollover is a distributed transaction without a protocol

The current rollover advances the Server registry first, then asks the iframe
to apply operations, then updates browser globals. Failure after the first step
requires compensating cleanup that guesses separate iframe and Server
revisions. The Workspace revision is already durable and cannot correctly be
rolled back in the browser.

Use an explicit projection transaction:

1. Commit the Workspace mutation under the project lock.
2. Create a pending projection with `transitionId`, expected execution,
   previous projection generation, target Workspace revision, and operations.
3. Apply operations in the iframe and return an acknowledgement bound to the
   transition ID and execution ID.
4. CAS-commit the Server projection.
5. Atomically replace the coordinator snapshot and publish context.

If steps 3-4 fail, the Workspace remains authoritative, the old projection is
explicitly marked behind, and recovery builds a candidate for the committed
Workspace revision. It does not synthesize rollback identities.

### 5. The model-visible API exposes internal coordinates

Prompting the model to copy `revision`, `runId`, and `nonce` exactly reduces
mistakes but does not create a reliable protocol. These values are routing and
ownership details already known by the Editor and Server.

Replace them with an opaque, owner-bound `runtimeRef` published by the Editor:

```ts
capture_runtime_frame({ runtimeRef, target?, ...captureOptions })
```

The Server resolves the ref to the current execution and projection and can
return a typed `RUNTIME_REF_STALE` response with a replacement ref. During a
compatibility window, legacy identity fields may be accepted internally but
must not remain the preferred model contract.

`activeIntent: "user-requested"` is also only a model assertion. The real
authority is the one-shot Editor grant. Active access should return a typed
`ACTIVE_CONFIRMATION_REQUIRED` outcome until the Editor issues a capability;
the command then consumes that capability. A prompt field must not represent
human consent.

### 6. The broker has implicit states and ambiguous terminal paths

The broker state is split across `request`, `pull`, `start`, `report`, and
`fail`. Preparation and execution have separate local timers, while the iframe
also interprets the deadline. `fail_runtime_command` labels every failure as a
preparation failure even when reporting or evidence validation failed.

Represent the broker as a discriminated union and expose one idempotent
terminal operation:

```ts
type CommandState =
  | { phase: 'queued'; prepareDeadline: number }
  | { phase: 'executing'; executionDeadline: number; target: TargetExecution }
  | { phase: 'settled'; outcome: CommandOutcome }

type CommandOutcome =
  | { status: 'succeeded'; evidence: RuntimeEvidence }
  | { status: 'failed'; stage: FailureStage; code: FailureCode; message: string }
  | { status: 'cancelled'; reason: string }
  | { status: 'expired'; stage: 'prepare' | 'execute' | 'settle' }
```

All parties use the one absolute deadline issued by the broker. Settlement is
idempotent by command ID. User-facing errors map from stable codes instead of
matching broad strings such as `stale or foreign`.

### 7. Build identity is coupled to too much content

`buildId` includes the complete Workspace revision. An Editor-state-only
change therefore creates a new build identity even when executable inputs are
unchanged, while the active iframe correctly continues running its old build.
This defeats the conceptual promise that immutable executable artifacts are
reused across state-only changes.

Long term, derive build identity from an executable input fingerprint:

```text
buildId = hash(builderVersion, dependencyProfile, backend, entry, input hashes)
```

Keep `sourceRevision` in build metadata for audit, but do not require it to
equal the current applied Workspace revision. Until that migration, the
protocol must explicitly retain both `loadedBuild.sourceRevision` and
`projection.workspaceRevision`.

### 8. Tests protect branches more than invariants

The repository has valuable browser coverage, but several focused tests assert
source text and error wording. The main broker coverage is one long sequential
test. This detects regressions after a scenario is known, but it does not
systematically explore the cross-product of lifecycle phase, target, revision
transition, owner generation, deadline, and terminal outcome.

Add pure model tests for:

- every legal and illegal coordinator transition;
- active, candidate, and validation identity uniqueness;
- projection success and failure before and after each commit point;
- command settlement idempotency at every phase;
- connection-generation rollover with active command, grant, and candidate;
- invariant preservation under cancellation and timeout.

Keep a small number of browser contract tests for rendering, iframe scheduling,
and real MCP transport. Source-regex tests should not be the primary guarantee.

### 9. Debug observability is coupled to production code

Multiple open investigations inject hard-coded collector URLs and temporary
App tools into lifecycle code. This has already caused evidence to be routed to
the wrong collector and makes concurrent investigations interfere.

Add one bounded internal lifecycle journal with structured events. A debug
adapter may forward that journal when enabled, but business code should only
emit through the journal interface. This is observability, not another state
owner.

## Target Ownership

| State | Sole owner | Persistence |
|---|---|---|
| Workspace content revision | `WorkspaceStore` project transaction | immutable revision + HEAD |
| Active execution and projection | owner-scoped `RuntimeRegistry` aggregate | one owner-scoped record |
| Candidate replacement | `RuntimeRegistry` prepared slot | expiring record |
| Browser frames and loaded resources | `RuntimeCoordinator` | in-memory only |
| Validation execution | `RuntimeCoordinator`, bound to one command/projection | in-memory, disposable |
| Harness command | `RuntimeCommandBroker` | in-memory lease with idempotent terminal outcome |
| Active permission | Editor-issued opaque capability | one-shot, owner and execution bound |
| Model context | post-commit effect | derived, never authoritative |

The Server currently keeps owner-scoped active entries in memory but writes one
workspace-wide `active-run.json`. That mismatch must be resolved explicitly:
either persistence is a single process-level ownership fence, or active records
are owner-scoped. It must not pretend to be both.

## Required Invariants

1. An execution ID never changes during an iframe lifetime.
2. Active and validation executions never share an execution ID.
3. A projection generation increases exactly once per acknowledged revision
   advance.
4. A build describes loaded executable inputs, not the mutable applied scene.
5. One coordinator snapshot contains every resource required to call a Runtime
   committed.
6. Registry projection commit is CAS-bound to execution ID and previous
   projection generation.
7. Evidence is bound to command ID, target execution ID, projection generation,
   owner, and deadline.
8. Every command reaches one idempotent terminal outcome and releases its
   lease.
9. Workspace commit failure changes no Runtime state; projection failure never
   rolls back committed Workspace content.
10. Model context and diagnostics cannot change lifecycle or ownership state.

## Migration Plan

Implementation status:

- R0 is complete: the incidents and invariants are recorded and covered by
  focused protocol and integration tests.
- R1 is in progress: execution, projection, build, typed failure, and opaque
  reference concepts exist, while the persisted legacy record remains during
  migration.
- R2's acknowledged projection CAS path is implemented.
- R3 remains open; lifecycle resources are still stored in several `src/view.ts`
  variables.
- R4 is in progress: model calls use `runtimeRef`, validation uses an independent
  execution and command token, and terminal outcomes are retained idempotently.
  The legacy identity and report/fail RPCs remain as compatibility adapters.

### R0: Freeze and characterize

- Do not add new fields to the current flat `RuntimeIdentity`.
- Keep current compatibility fixes and open debug evidence.
- Add a transition matrix and pure invariant tests for current behavior.

Exit: every known incident maps to an invariant or an explicitly independent
transport limit.

### R1: Normalize internal types

- Introduce `ExecutionId`, `RuntimeProjection`, `BuildRef`, and typed broker
  outcomes.
- Replace optional-field `ActiveRuntime` with discriminated owned/legacy forms.
- Centralize equality and error-code mapping.

Exit: invalid combinations cannot be constructed without an explicit legacy
adapter.

### R2: Complete authoritative projection

- Add pending projection and acknowledged CAS commit.
- Move Editor mutation + pending registry advance under one project lock.
- On projection failure, recover from the committed Workspace revision instead
  of compensating browser rollback.

Exit: Workspace, registry, and iframe convergence is tested after success,
timeout, cancellation, reconnect, and injected acknowledgement failure.

### R3: Make the coordinator the real owner

- Move active frame, run, build, token, candidate, and validation state into one
  coordinator aggregate.
- Remove direct lifecycle resource writes from event handlers.
- Publish UI and model context only from committed snapshots.

Exit: no lifecycle resource has a second mutable owner in `src/view.ts`.

### R4: Simplify Harness authority

- Replace model-supplied run/nonce/revision with opaque `runtimeRef`.
- Give validation an internal execution ID and command-bound evidence token.
- Replace `activeIntent` assertion with a structured confirmation outcome and
  Editor-issued capability.
- Collapse report/fail into idempotent settlement.

Exit: ordinary validation tools cannot fail because the model copied or
invented internal identity fields.

### R5: Remove legacy paths and harden

- Delete compatibility registration paths, duplicate queues, source-regex
  tests, temporary probe tools, and hard-coded collectors after their debug
  sessions are accepted.
- Run transition fault injection, reconnect tests, five-cycle browser CI, and
  the 50-cycle Snow soak.

Exit: one identity model, one client coordinator, one server registry
aggregate, one broker state machine, and no retained legacy lifecycle path.

## Recommended Next Milestone

Do not continue with another feature milestone on the current flat identity.
The next implementation milestone should be R1 plus the pure invariant test
matrix. It is deliberately behavior-preserving and creates the type boundaries
needed for R2-R4 without another broad rewrite.

The current rollover fix should remain until R2 replaces it. Removing it now
would reintroduce the observed screenshot failure.
