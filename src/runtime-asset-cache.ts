export const RUNTIME_ASSET_CACHE_LIMIT = 16

export class RuntimeAssetCache {
  private readonly entries = new Map<string, Promise<ArrayBuffer>>()
  private readonly limit: number

  constructor(limit = RUNTIME_ASSET_CACHE_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error('Runtime asset cache limit must be a positive integer')
    }
    this.limit = limit
  }

  get(hash: string, load: () => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
    const cached = this.entries.get(hash)
    if (cached !== undefined) {
      this.entries.delete(hash)
      this.entries.set(hash, cached)
      return cached
    }
    const pending = load()
    this.entries.set(hash, pending)
    if (this.entries.size > this.limit) {
      this.entries.delete(this.entries.keys().next().value!)
    }
    void pending.catch(() => {
      if (this.entries.get(hash) === pending) this.entries.delete(hash)
    })
    return pending
  }

  clear(): void {
    this.entries.clear()
  }

  get size(): number {
    return this.entries.size
  }
}
