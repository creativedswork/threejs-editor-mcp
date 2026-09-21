export interface RuntimeEffectFailure {
  name: string
  error: unknown
}

export class RuntimeEffects {
  readonly #timeoutMs: number
  readonly #onFailure: (failure: RuntimeEffectFailure) => void
  readonly #pending = new Set<Promise<void>>()

  constructor(
    timeoutMs: number,
    onFailure: (failure: RuntimeEffectFailure) => void,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Runtime effect timeout must be positive')
    }
    this.#timeoutMs = timeoutMs
    this.#onFailure = onFailure
  }

  run(name: string, effect: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    const task = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`Runtime effect ${name} timed out`)
        controller.abort(error)
        reject(error)
      }, this.#timeoutMs)
      void effect(controller.signal).then(resolve, reject).finally(() => clearTimeout(timer))
    }).catch(error => {
      this.#onFailure({ name, error })
    })
    this.#pending.add(task)
    void task.finally(() => this.#pending.delete(task))
  }

  async idle(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending])
    }
  }
}
