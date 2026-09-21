# Runtime Lifecycle Recovery

Status: Proposed
Scope: `threejs-editor-mcp`
Date: 2026-08-28

## Summary

Play, Stop, Save, Reload, Runtime replacement, Workspace revision updates, and
host-side context publication currently share overlapping asynchronous paths.
The UI exposes intermediate state as ready, while later work can still fail and
roll back an already rendered Runtime. This produces the recurring black
screen, white flash, restore failure, and indefinite Saving symptoms.

The fix is a local lifecycle redesign:

1. Introduce one `RuntimeTransitionController` as the only owner of lifecycle
   phase, transition epoch, cancellation, and UI readiness.
2. Separate preparation from commit. The previous committed Runtime remains
   visible until a candidate Runtime is ready.
3. Treat Workspace and Runtime identity as authorities with explicit commit
   points.
4. Move model context, diagnostics, and telemetry into bounded post-commit
   effects that cannot roll back a healthy Runtime.
5. Make Save exit through one cleanup path on success, conflict, timeout,
   cancellation, or failure.

This change remains inside `threejs-editor-mcp`. It does not require DSH
Session, MCP App host, or Snow example changes.

## Evidence

The current implementation has these structural properties:

- `src/view.ts` contains 22 mutable M7 lifecycle values.
- `data-play-state` is assigned in 26 places and `data-sync` in 30 places.
- Stop first changes the active Runtime to edit mode, then performs another
  complete Runtime start.
- Runtime startup combines build, assets, validation, server registration,
  iframe replacement, scene projection, UI enablement, and model-context
  publication.
- The UI enters `editing` before the startup Promise and model-context
  publication have settled.
- Save is not serialized with Runtime startup. It implements a second revision
  rollover path with its own compensating cleanup.
- Browser tests commonly wait for `playState === "editing"`, which is an early
  UI projection rather than a lifecycle completion barrier.
- The visible-surface preservation changes in `ef47308` and `ca0c8cb` reduce
  flashing but compensate for non-atomic Runtime replacement.

The project lock and immutable Workspace revisions are sound foundations. The
primary defect is orchestration above them, not storage locking and not DSH
Session management.

## Goals

- Make Play, Stop, Save, Reload, and external revision adoption mutually
  serialized.
- Preserve the last committed visible Runtime until replacement commits.
- Restore the edit state that existed immediately before Play.
- Prevent stale iframe events from mutating current state.
- Ensure every operation has a deadline and every UI lock has a guaranteed
  release path.
- Keep auxiliary integration failures visible but non-destructive.
- Provide stage-level progress instead of a generic busy state.
- Cover large local assets, repeated cycles, immediate Save after Stop, and
  injected failures.

## Non-Goals

- Replacing Three.js, MCP Apps, or the Workspace revision model.
- Introducing an external state-machine dependency.
- Changing DSH Session management or `dsh-uni-editor`.
- Modifying example projects to hide Runtime defects.
- Preserving arbitrary game simulation state after Stop.
- Supporting concurrent lifecycle mutations against one editor view.

## Design Principles

### One writer

Only `RuntimeTransitionController` may change lifecycle phase or the committed
Runtime reference. Event handlers submit commands; they do not mutate
lifecycle globals.

### One committed projection

The UI derives buttons, status, editor interactivity, and `data-*` attributes
from the controller snapshot. It never infers readiness from an intermediate
Promise callback.

### Prepare, then commit

Potentially failing work happens against a candidate. The active Runtime is
retained until the candidate has:

- loaded the expected build and assets;
- emitted a matching `ready`;
- emitted an acceptable editor scene;
- passed the Runtime registry commit check.

### Authoritative persistence

Once a Workspace revision commits, it is not rolled back in the browser.
Failure to project that revision into the current iframe triggers recovery from
the new authoritative snapshot.

### Post-commit isolation

Model context, diagnostics, and telemetry execute after commit. Their timeout
or failure records degraded integration state but never tears down the active
Runtime.

## Target Architecture

[Open the interactive target architecture diagram](../../reports/runtime-lifecycle-target.architecture.html)

[Architecture diagram source](../../reports/runtime-lifecycle-target.architecture.json)

The diagram answers one question: which component owns each state transition
and where does irreversible work happen?

### RuntimeTransitionController

The controller is a small local module, not a framework. It owns:

- the current phase;
- a monotonically increasing transition epoch;
- one active `AbortController`;
- the committed Runtime descriptor;
- the current operation and deadline;
- the pre-Play edit baseline;
- one serialized command queue.

It exposes commands such as `play()`, `stop()`, `save()`, `reload()`, and
`adoptSnapshot()`. Each command resolves only after the controller reaches a
committed stable state or a recoverable failure.

### Build and asset cache

Build output, validation result, and asset blobs are addressed by
`projectId + revision + buildId`.

Stop on an unchanged revision reuses these artifacts. It must not call the
builder or fetch the same asset chunks again. Validation runs once per build,
not once per mode transition.

### Candidate Runtime

A candidate starts away from the committed visible surface. It may fail or be
cancelled without disposing the active Runtime.

The candidate becomes active only after the controller and Runtime registry
complete a commit handshake. The previous Runtime is disposed after promotion.

### Workspace Store

The Workspace remains the source revision authority. Save applies editor
operations under the existing project lock and produces one immutable
snapshot.

### Runtime Registry

The registry remains the run-evidence authority. It gains a prepare/commit
boundary for Runtime replacement:

```ts
interface PreparedRuntimeRun {
  projectId: string
  revision: string
  runId: string
  nonce: string
  evidenceToken: string
  expiresAt: number
}
```

`prepareRuntimeRun()` does not invalidate the current active run.
`commitRuntimeRun()` performs a compare-and-swap against the expected active
run and promotes the prepared run. Uncommitted preparations expire.

### Post-Commit Outbox

The outbox executes:

- `updateModelContext`;
- Runtime diagnostics reports;
- lifecycle telemetry.

Each task has a short deadline and correlation fields:

```ts
interface LifecycleEvidence {
  projectId: string
  revision: string
  runId?: string
  epoch: number
  transition: RuntimeCommand
  stage: string
  elapsedMs: number
}
```

Failure updates observability only. It cannot change Runtime phase.

## State Model

[Open the interactive lifecycle state diagram](../../reports/runtime-lifecycle-target.lifecycle.html)

[Lifecycle diagram source](../../reports/runtime-lifecycle-target.lifecycle.json)

The primary state is intentionally small:

```ts
type RuntimePhase =
  | 'bootstrapping'
  | 'edit-ready'
  | 'entering-play'
  | 'playing'
  | 'restoring'
  | 'saving'
  | 'recoverable-failure'
  | 'disposed'

interface RuntimeLifecycleState {
  phase: RuntimePhase
  epoch: number
  committed?: RuntimeRun
  operation?: {
    command: RuntimeCommand
    startedAt: number
    deadlineAt: number
  }
  baseline?: EditBaseline
  failure?: RuntimeFailure
}
```

Post-commit effects are orthogonal work, not another primary Runtime phase.

### Stable states

`edit-ready` and `playing` are the only interactive idle states.

- Edit controls and Save are available only in `edit-ready`.
- Stop is available only in `playing`.
- Reload is available in stable states and `recoverable-failure`.

### Transition states

`bootstrapping`, `entering-play`, `restoring`, and `saving` disable conflicting
commands. They expose their current stage to the status UI.

### Recoverable failure

A failed pre-commit transition retains the previous committed surface.
Recovery displays the failed stage and offers Retry or Reload. It does not
project partial hierarchy, selection, or revision state.

### Invariants

The implementation must assert these invariants in development and tests:

1. At most one lifecycle operation is active per editor view.
2. Only an event with the current epoch may mutate controller state.
3. An interactive UI phase always has one committed Runtime.
4. `edit-ready` requires Runtime revision, Workspace revision, and registry
   revision to agree.
5. Candidate failure cannot dispose the committed Runtime.
6. Post-commit failure cannot change the committed Runtime.
7. Every transition settles as success, recoverable failure, cancellation, or
   timeout.
8. Every Save path restores controls in `finally`.

## Core Workflows

### Initial open

1. Enter `bootstrapping` and allocate an epoch.
2. Resolve the authoritative Workspace snapshot.
3. Build or reuse its immutable artifact.
4. Start a candidate edit Runtime.
5. Wait for matching `ready` and editor scene evidence.
6. Commit its registry identity.
7. Promote the candidate and publish `edit-ready`.
8. Enqueue model context and diagnostics after commit.

No empty editable surface is exposed before step 7.

### Play

1. Accept Play only from `edit-ready`.
2. Capture an `EditBaseline`:
   - Workspace revision and build ID;
   - pending editor operations;
   - scene projection required for restoration;
   - selected object and camera state.
3. Enter `entering-play`.
4. Send `set-mode(run)` with the current epoch.
5. Wait for the matching mode acknowledgement.
6. Commit `playing`.

Play reuses the current Runtime. It does not build or replace an iframe.

### Stop

1. Accept Stop only from `playing`.
2. Enter `restoring`; freeze interaction and retain the active surface.
3. Reuse the pre-Play artifact and start a clean edit candidate.
4. Reapply pending editor operations and the saved edit baseline.
5. Wait for candidate `ready` and editor scene evidence.
6. Prepare and commit the candidate Runtime identity.
7. Atomically promote the candidate.
8. Restore selection and camera.
9. Commit `edit-ready`.
10. Dispose the previous Runtime and enqueue diagnostics.

This removes the current sequence of switching the live run to edit and then
rebuilding it in place. The old surface remains coherent until promotion, so
`preserveSurface` is no longer a correctness mechanism.

If complete baseline restoration is unavailable for a project adapter, the
controller rebuilds from source and replays known editor operations. The UI
must identify this as degraded restoration rather than silently claiming exact
continuity.

### Save

1. Accept Save only from `edit-ready` with pending operations.
2. Enter `saving` and capture the expected project, revision, run, and epoch.
3. Submit one server operation:

```ts
interface CommitEditorOperationsInput {
  projectId: string
  baseRevision: string
  runId: string
  operations: EditorOperation[]
}

interface CommitEditorOperationsResult {
  snapshot: WorkspaceSnapshot
  runtime: RuntimeRun
}
```

4. Under one project lock, validate the base revision and active run, apply
   operations, commit the new Workspace revision, and advance the registry.
5. Apply the returned revision and evidence token to the active iframe.
6. On projection failure, recover by loading the already committed snapshot;
   do not pretend the server commit rolled back.
7. Settle in `edit-ready` or `recoverable-failure`.
8. Restore UI controls in one `finally` block.
9. Enqueue model context after the stable state commits.

All MCP requests in this path have explicit stage deadlines. There is no branch
that returns while `sync === "saving"`.

### Reload and external revision

Reload cancels the current epoch, disposes uncommitted candidates, reads the
latest authoritative snapshot, and enters `bootstrapping`.

An external revision discovered during Play, Stop, or Save is queued behind the
current transition. The controller adopts it only after the active operation
settles; it never interleaves snapshot acceptance with Save.

## Runtime Protocol Changes

Every lifecycle request and response carries:

```ts
interface RuntimeEnvelope {
  runId: string
  nonce: string
  epoch: number
}
```

Required Runtime messages:

- `set-mode` and `mode-set`;
- `suspend` and `suspended`;
- `set-revision` and `revision-set`;
- `dispose` and `disposed`;
- `ready`;
- `editor-scene`;
- `runtime-error`.

The parent rejects messages with an old epoch before invoking any stateful
handler.

## UI Projection

One function derives all control state:

```ts
function projectRuntimeUi(state: RuntimeLifecycleState, dirty: boolean): UiState
```

It controls:

- Play and Stop availability;
- Save availability;
- transform controls;
- status text and progress stage;
- retry and reload actions;
- `data-play-state`, `data-sync`, and test observability.

The DOM attributes become projections, not authorities.

The status surface uses explicit stages:

- Preparing build
- Loading assets
- Starting editor
- Entering Play
- Restoring edit state
- Committing revision
- Finalizing Save

This prevents a long operation from appearing frozen.

## Code Changes

### New modules

`src/runtime-lifecycle.ts`

- lifecycle types and invariants;
- serialized command queue;
- epoch and cancellation;
- transition implementation;
- stable-state readiness Promise.

`src/runtime-effects.ts`

- bounded post-commit tasks;
- retry policy;
- lifecycle evidence emission.

No external dependency is required.

### Existing modules

`src/view.ts`

- retain DOM construction and rendering;
- replace direct lifecycle mutation with controller commands;
- centralize UI projection;
- remove duplicate Save/Stop cleanup branches.

`src/workspace-runtime.ts`

- carry epoch in lifecycle messages;
- add suspend acknowledgement;
- make revision update acknowledgement explicit;
- preserve deterministic dispose semantics.

`src/workspaces.ts`

- expose an internal locked editor-operation commit primitive;
- preserve existing immutable revision and conflict behavior.

`src/server.ts`

- add prepared Runtime registration with expiry;
- add compare-and-swap Runtime promotion;
- combine editor operation commit and registry revision advance;
- keep existing tools during migration, then remove private legacy paths.

## Migration Plan

### Phase 0: Characterization

- Add lifecycle event recording without changing behavior.
- Add an `awaitLifecycleIdle()` browser-test hook.
- Add the Snow large-asset fixture and current failure reproductions.
- Record stage timings and active Runtime counts.

Exit condition: tests reproduce premature `editing`, Save overlap, and
post-commit failure propagation.

### Phase 1: Single transition owner

- Add `RuntimeTransitionController`.
- Route Play, Stop, Save, Reload, and external snapshots through one queue.
- Derive UI state from controller snapshots.
- Keep current Runtime start implementation behind controller ports.
- Move model context and diagnostics to post-commit effects.

Exit condition: no command overlap; host-context failure cannot change Runtime
phase; Save always unlocks the UI.

### Phase 2: Atomic Stop replacement

- Introduce candidate Runtime preparation.
- Cache validation by build ID.
- Add prepared/committed Runtime registry operations.
- Promote the candidate before disposing the previous Runtime.
- Remove correctness dependence on `preserveSurface`.

Exit condition: repeated Play/Stop produces no blank frame and does not rebuild
an unchanged revision.

### Phase 3: Authoritative Save

- Add the combined server-side editor commit.
- Replace compensating browser rollback with reload from committed snapshot.
- Add explicit revision acknowledgement in the Runtime.

Exit condition: Workspace, registry, and iframe revisions converge after every
success, conflict, timeout, and injected projection failure.

### Phase 4: Removal and hardening

- Remove superseded M7 lifecycle globals and duplicate queues.
- Remove private legacy tools after all call sites migrate.
- Run soak cycles and context-loss recovery.
- Clean debug probes only after user confirmation.

Exit condition: no legacy lifecycle path remains and release checks pass.

## Test Strategy

### Unit tests

- legal and illegal state transitions;
- stale epoch rejection;
- command serialization;
- cancellation and deadline settlement;
- UI projection for every phase;
- Save cleanup on every exit;
- post-commit failure isolation.

### Server tests

- prepared Runtime expiry;
- compare-and-swap promotion;
- stale active-run rejection;
- editor operation commit under one project lock;
- revision conflict leaves registry unchanged;
- committed revision survives client projection failure.

### Browser tests

- initial open to lifecycle idle;
- Play and Stop once;
- repeated Play/Stop cycles;
- Play/Stop with selection and camera preservation;
- dirty edit, Play, Stop, then Save;
- immediate Save after Stop button becomes available;
- model-context timeout;
- diagnostics failure;
- missing scene report;
- candidate startup failure;
- Runtime context loss;
- external revision during each transition;
- Snow project with GLB, five dynamic asphalt textures, KTX2 setup, and
  post-processing.

### Assertions

Tests must assert more than `playState`:

- controller phase is stable;
- no transition Promise remains;
- no candidate remains after settlement;
- exactly one active Runtime is registered;
- Workspace, registry, and iframe revisions agree;
- expected controls are enabled;
- canvas pixels are nonblank before and after promotion;
- old WebGL resources are eventually disposed;
- no unhandled rejection or listener warning occurred.

CI runs five Play/Stop/Save cycles. A release soak runs at least 50 cycles on
the Snow project.

## Acceptance Criteria

- Stop restores the pre-Play edit baseline without a black or white frame.
- Save cannot start before Stop reaches committed `edit-ready`.
- Save always settles within its configured deadline and never remains
  indefinitely in Saving.
- A model-context or diagnostics failure leaves the current Runtime usable.
- Candidate failure retains the previous committed surface and exposes Retry.
- Repeated unchanged-revision Stop does not invoke build or asset download.
- Stale iframe events do not change hierarchy, selection, revision, or UI
  phase.
- All lifecycle tests pass with zero unhandled rejections and one active
  Runtime per view.

## Risks and Mitigations

### Candidate Runtime increases temporary GPU usage

Only one candidate may exist. It has a setup deadline and is disposed on every
non-commit exit. The previous Runtime is disposed immediately after promotion.

### Two-phase registry adds server state

Prepared runs are owner-scoped, compare-and-swap committed, and expire after a
short TTL. They never count as active evidence.

### Edit baseline may be incomplete

Capture pending operations, scene projection, selection, and camera
explicitly. Add an adapter snapshot/restore hook where source reconstruction is
not deterministic. Report degraded restoration instead of silently losing
state.

### Migration can temporarily duplicate paths

Each phase has an exit condition and removes the replaced path before moving
on. Do not retain a long-lived feature flag or two production state machines.

## Rejected Approaches

### Add more flags to `src/view.ts`

This preserves the distributed state problem and increases invalid
combinations.

### Increase timeouts

Longer waits do not fix premature readiness, overlapping transitions, or
incorrect rollback boundaries.

### Keep rebuilding the visible iframe and preserve its last pixels

This masks replacement latency but cannot provide an atomic Runtime commit.

### Make DSH absorb failures

The host should not define Three.js lifecycle correctness. Context publication
is an integration side effect, not a Runtime commit participant.

### Introduce XState or another state-machine package

The required state space is small. A typed local controller and pure transition
tests are sufficient.

## Implementation Order

1. Land characterization tests and lifecycle-idle observability.
2. Introduce the controller around existing operations.
3. Isolate post-commit effects and fix Save cleanup.
4. Add candidate Runtime promotion for Stop.
5. Add authoritative Save commit.
6. Remove legacy state and run release hardening.

The first implementation change should be Phase 0. It creates a reliable
failure baseline before altering lifecycle behavior.
