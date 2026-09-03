export type RuntimeCommand =
  | 'bootstrap'
  | 'play'
  | 'stop'
  | 'save'
  | 'reload'
  | 'adopt-snapshot'

export type RuntimePhase =
  | 'bootstrapping'
  | 'edit-ready'
  | 'entering-play'
  | 'playing'
  | 'restoring'
  | 'saving'
  | 'recoverable-failure'
  | 'disposed'

export interface RuntimeFailure {
  command: RuntimeCommand
  message: string
}

export interface RuntimeLifecycleSnapshot<
  Runtime,
  Candidate = never,
  Validation = never,
> {
  phase: RuntimePhase
  epoch: number
  committed?: Runtime
  candidate?: Candidate
  validation?: Validation
  operation?: {
    command: RuntimeCommand
    startedAt: number
    deadlineAt: number
  }
  failure?: RuntimeFailure
}

export interface RuntimeTransitionContext<Runtime> {
  epoch: number
  signal: AbortSignal
  committed: Runtime | undefined
  isCurrent: () => boolean
}

export interface RuntimeTransitionResult<Runtime, Value> {
  phase: 'edit-ready' | 'playing' | 'disposed'
  value: Value
  committed?: Runtime | null
}

export class RuntimeTransitionError extends Error {}

export class RuntimeCoordinator<
  Runtime,
  Candidate = never,
  Validation = never,
> {
  readonly #now: () => number
  readonly #listeners = new Set<(
    snapshot: RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>,
  ) => void>()
  readonly #idleWaiters = new Set<() => void>()
  #active?: { epoch: number; controller: AbortController }
  #pending = 0
  #tail = Promise.resolve()
  #snapshot: RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>

  constructor(
    onSnapshot?: (
      snapshot: RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>,
    ) => void,
    now: () => number = Date.now,
  ) {
    this.#now = now
    this.#snapshot = Object.freeze({ phase: 'disposed', epoch: 0 })
    if (onSnapshot !== undefined) this.#listeners.add(onSnapshot)
  }

  snapshot(): Readonly<RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>> {
    return this.#snapshot
  }

  subscribe(
    listener: (
      snapshot: RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>,
    ) => void,
  ): () => void {
    this.#listeners.add(listener)
    listener(this.#snapshot)
    return () => this.#listeners.delete(listener)
  }

  isCurrent(epoch: number): boolean {
    return this.#snapshot.epoch === epoch
      && this.#active?.epoch === epoch
      && this.#active.controller.signal.aborted === false
  }

  setCandidate(epoch: number, candidate: Candidate | undefined): void {
    this.#assertCurrentEpoch(epoch)
    this.#replaceResources({ candidate })
  }

  discardCandidate(candidate: Candidate): void {
    if (this.#snapshot.candidate === candidate) {
      this.#replaceResources({ candidate: undefined })
    }
  }

  commitCandidate(epoch: number, candidate: Candidate, committed: Runtime): void {
    this.#assertCurrentEpoch(epoch)
    if (this.#snapshot.candidate !== candidate) {
      throw new RuntimeTransitionError('Cannot commit a stale Runtime candidate')
    }
    this.#replaceResources({
      committed,
      candidate: undefined,
      validation: undefined,
    })
  }

  replaceCommitted(epoch: number, expected: Runtime, committed?: Runtime): void {
    this.#assertCurrentEpoch(epoch)
    if (this.#snapshot.committed !== expected) {
      throw new RuntimeTransitionError('Cannot replace a stale committed Runtime')
    }
    this.#replaceResources({ committed })
  }

  releaseCommitted(expected: Runtime): void {
    if (this.#snapshot.operation !== undefined) {
      throw new RuntimeTransitionError('Cannot release a committed Runtime during a transition')
    }
    if (this.#snapshot.committed !== expected) {
      throw new RuntimeTransitionError('Cannot release a stale committed Runtime')
    }
    this.#setSnapshot({
      phase: 'disposed',
      epoch: this.#snapshot.epoch + 1,
      ...this.#snapshot.validation === undefined
        ? {}
        : { validation: this.#snapshot.validation },
    })
  }

  setValidation(expected: Runtime | undefined, validation?: Validation): void {
    if (this.#snapshot.committed !== expected) {
      throw new RuntimeTransitionError('Cannot replace validation for a stale Runtime')
    }
    this.#replaceResources({ validation })
  }

  cancelActive(reason = 'Runtime transition cancelled'): void {
    if (this.#active === undefined) return
    const command = this.#snapshot.operation?.command
    this.#active.controller.abort(new RuntimeTransitionError(reason))
    this.#setSnapshot({
      phase: 'recoverable-failure',
      epoch: this.#snapshot.epoch + 1,
      ...this.#snapshot.committed === undefined
        ? {}
        : { committed: this.#snapshot.committed },
      ...this.#snapshot.candidate === undefined
        ? {}
        : { candidate: this.#snapshot.candidate },
      ...this.#snapshot.validation === undefined
        ? {}
        : { validation: this.#snapshot.validation },
      ...command === undefined
        ? {}
        : { failure: { command, message: reason } },
    })
  }

  enqueue<Value>(
    command: RuntimeCommand,
    timeoutMs: number,
    transition: (
      context: RuntimeTransitionContext<Runtime>,
    ) => Promise<RuntimeTransitionResult<Runtime, Value>>,
  ): Promise<Value> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RuntimeTransitionError('Runtime transition timeout must be positive'))
    }
    this.#pending += 1
    const scheduled = this.#tail.then(() => this.#execute(command, timeoutMs, transition))
    this.#tail = scheduled.then(() => undefined, () => undefined)
    void scheduled.then(
      () => this.#settled(),
      () => this.#settled(),
    )
    return scheduled
  }

  idle(): Promise<Readonly<RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>>> {
    if (this.#pending === 0 && this.#snapshot.operation === undefined) {
      return Promise.resolve(this.#snapshot)
    }
    return new Promise(resolve => {
      this.#idleWaiters.add(() => resolve(this.#snapshot))
    })
  }

  async #execute<Value>(
    command: RuntimeCommand,
    timeoutMs: number,
    transition: (
      context: RuntimeTransitionContext<Runtime>,
    ) => Promise<RuntimeTransitionResult<Runtime, Value>>,
  ): Promise<Value> {
    this.#assertCommand(command)
    const epoch = this.#snapshot.epoch + 1
    const controller = new AbortController()
    const startedAt = this.#now()
    this.#active = { epoch, controller }
    this.#setSnapshot({
      phase: transitionPhase(command),
      epoch,
      ...this.#snapshot.committed === undefined
        ? {}
        : { committed: this.#snapshot.committed },
      ...this.#snapshot.candidate === undefined
        ? {}
        : { candidate: this.#snapshot.candidate },
      ...this.#snapshot.validation === undefined
        ? {}
        : { validation: this.#snapshot.validation },
      operation: {
        command,
        startedAt,
        deadlineAt: startedAt + timeoutMs,
      },
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new RuntimeTransitionError(`Runtime ${command} timed out`)
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      })
      const result = await Promise.race([
        transition({
          epoch,
          signal: controller.signal,
          committed: this.#snapshot.committed,
          isCurrent: () => this.isCurrent(epoch),
        }),
        timedOut,
      ])
      if (!this.isCurrent(epoch)) {
        throw new RuntimeTransitionError(`Rejected stale Runtime ${command} epoch ${String(epoch)}`)
      }
      const committed = result.committed === null
        ? undefined
        : result.committed ?? this.#snapshot.committed
      this.#assertStable(result.phase, committed)
      this.#setSnapshot({
        phase: result.phase,
        epoch,
        ...committed === undefined ? {} : { committed },
        ...this.#snapshot.candidate === undefined
          ? {}
          : { candidate: this.#snapshot.candidate },
        ...this.#snapshot.validation === undefined
          ? {}
          : { validation: this.#snapshot.validation },
      })
      return result.value
    } catch (error) {
      if (this.#snapshot.epoch === epoch) {
        this.#setSnapshot({
          phase: command === 'save' && this.#snapshot.committed !== undefined
            ? 'edit-ready'
            : 'recoverable-failure',
          epoch,
          ...this.#snapshot.committed === undefined
            ? {}
            : { committed: this.#snapshot.committed },
          ...this.#snapshot.candidate === undefined
            ? {}
            : { candidate: this.#snapshot.candidate },
          ...this.#snapshot.validation === undefined
            ? {}
            : { validation: this.#snapshot.validation },
          failure: {
            command,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (this.#active?.epoch === epoch) this.#active = undefined
    }
  }

  #assertCommand(command: RuntimeCommand): void {
    if (this.#snapshot.operation !== undefined) {
      throw new RuntimeTransitionError('Runtime lifecycle operation overlap')
    }
    const phase = this.#snapshot.phase
    const allowed = command === 'play'
      ? phase === 'edit-ready'
      : command === 'stop'
        ? phase === 'playing'
        : command === 'save'
          ? phase === 'edit-ready'
          : phase === 'disposed'
            || phase === 'edit-ready'
            || phase === 'playing'
            || phase === 'recoverable-failure'
    if (!allowed) {
      throw new RuntimeTransitionError(`Cannot ${command} while Runtime is ${phase}`)
    }
  }

  #assertStable(phase: RuntimePhase, committed: Runtime | undefined): void {
    if (phase !== 'edit-ready' && phase !== 'playing' && phase !== 'disposed') {
      throw new RuntimeTransitionError(`Runtime transition settled in unstable phase ${phase}`)
    }
    if ((phase === 'edit-ready' || phase === 'playing') && committed === undefined) {
      throw new RuntimeTransitionError(`Runtime ${phase} requires a committed Runtime`)
    }
    if (this.#snapshot.candidate !== undefined) {
      throw new RuntimeTransitionError(`Runtime ${phase} cannot retain a candidate`)
    }
  }

  #assertCurrentEpoch(epoch: number): void {
    if (!this.isCurrent(epoch)) {
      throw new RuntimeTransitionError(`Rejected stale Runtime epoch ${String(epoch)}`)
    }
  }

  #replaceResources(resources: {
    committed?: Runtime
    candidate?: Candidate
    validation?: Validation
  }): void {
    const snapshot = {
      ...this.#snapshot,
      ...resources,
    }
    this.#setSnapshot(snapshot)
  }

  #setSnapshot(
    snapshot: RuntimeLifecycleSnapshot<Runtime, Candidate, Validation>,
  ): void {
    this.#snapshot = Object.freeze(snapshot)
    for (const listener of this.#listeners) listener(this.#snapshot)
  }

  #settled(): void {
    this.#pending -= 1
    if (this.#pending !== 0 || this.#snapshot.operation !== undefined) return
    const waiters = [...this.#idleWaiters]
    this.#idleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

export { RuntimeCoordinator as RuntimeTransitionController }

function transitionPhase(command: RuntimeCommand): RuntimePhase {
  if (command === 'play') return 'entering-play'
  if (command === 'stop') return 'restoring'
  if (command === 'save') return 'saving'
  return 'bootstrapping'
}
