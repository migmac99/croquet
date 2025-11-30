import type { SnapshotMeta } from './types'

/**
 * R2-backed snapshot storage for session state persistence
 */
export class SnapshotStorage {
  constructor(
    private bucket: R2Bucket,
    private sessionId: string
  ) {}

  private get prefix(): string {
    return `sessions/${this.sessionId}/`
  }

  /**
   * Save a snapshot to R2
   */
  async save(data: ArrayBuffer | Uint8Array | string, time: number, seq: number): Promise<SnapshotMeta> {
    const key = `${this.prefix}snapshots/${time}-${seq}.bin`
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data

    const meta: SnapshotMeta = {
      sessionId: this.sessionId,
      time,
      seq,
      size: body.byteLength,
      createdAt: Date.now(),
    }

    await this.bucket.put(key, body, {
      customMetadata: {
        time: String(time),
        seq: String(seq),
        createdAt: String(meta.createdAt),
      },
    })

    // Also save as "latest" for quick access
    await this.bucket.put(`${this.prefix}latest.bin`, body, {
      customMetadata: {
        time: String(time),
        seq: String(seq),
        createdAt: String(meta.createdAt),
      },
    })

    return meta
  }

  /**
   * Load the latest snapshot
   */
  async loadLatest(): Promise<{ data: ArrayBuffer; meta: SnapshotMeta } | null> {
    const obj = await this.bucket.get(`${this.prefix}latest.bin`)
    if (!obj) return null

    const data = await obj.arrayBuffer()
    const meta: SnapshotMeta = {
      sessionId: this.sessionId,
      time: Number(obj.customMetadata?.time || 0),
      seq: Number(obj.customMetadata?.seq || 0),
      size: data.byteLength,
      createdAt: Number(obj.customMetadata?.createdAt || 0),
    }

    return { data, meta }
  }

  /**
   * Load a specific snapshot by time/seq
   */
  async load(time: number, seq: number): Promise<ArrayBuffer | null> {
    const key = `${this.prefix}snapshots/${time}-${seq}.bin`
    const obj = await this.bucket.get(key)
    return obj ? obj.arrayBuffer() : null
  }

  /**
   * List available snapshots
   */
  async list(limit = 10): Promise<SnapshotMeta[]> {
    const listed = await this.bucket.list({
      prefix: `${this.prefix}snapshots/`,
      limit,
    })

    return listed.objects.map((obj) => ({
      sessionId: this.sessionId,
      time: Number(obj.customMetadata?.time || 0),
      seq: Number(obj.customMetadata?.seq || 0),
      size: obj.size,
      createdAt: Number(obj.customMetadata?.createdAt || obj.uploaded.getTime()),
    }))
  }

  /**
   * Delete old snapshots, keeping only the N most recent
   */
  async prune(keepCount = 5): Promise<number> {
    const listed = await this.bucket.list({
      prefix: `${this.prefix}snapshots/`,
    })

    // Sort by creation time descending
    const sorted = listed.objects.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())

    // Delete everything after keepCount
    const toDelete = sorted.slice(keepCount)
    if (toDelete.length === 0) return 0

    await Promise.all(toDelete.map((obj) => this.bucket.delete(obj.key)))
    return toDelete.length
  }

  /**
   * Delete all data for this session
   */
  async deleteAll(): Promise<void> {
    const listed = await this.bucket.list({ prefix: this.prefix })
    await Promise.all(listed.objects.map((obj) => this.bucket.delete(obj.key)))
  }
}

/**
 * Message log storage for debugging/replay (optional)
 */
export class MessageLogStorage {
  constructor(
    private bucket: R2Bucket,
    private sessionId: string
  ) {}

  async append(messages: unknown[]): Promise<void> {
    const key = `sessions/${this.sessionId}/logs/${Date.now()}.json`
    await this.bucket.put(key, JSON.stringify(messages))
  }
}
