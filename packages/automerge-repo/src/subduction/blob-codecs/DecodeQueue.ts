import type { DocumentId } from "../../types.js"
import type { SubductionBlobCodec } from "./types.js"

export class BlobDecodeQueue {
  #pending: Uint8Array[] = []
  #running: Promise<void> | null = null
  #blocked = false

  constructor(
    private readonly documentId: DocumentId,
    private readonly codec: SubductionBlobCodec,
    private readonly onDecoded: (blobs: Uint8Array[]) => void,
    private readonly onBlockedChanged: (blocked: boolean) => void,
    private readonly onError: (error: unknown) => void
  ) {}

  get blocked(): boolean {
    return this.#blocked
  }

  async push(blob: Uint8Array): Promise<void> {
    await this.pushMany([blob])
  }

  async pushMany(blobs: Uint8Array[]): Promise<void> {
    if (blobs.length === 0) return
    this.#pending.push(...blobs)
    await this.#ensureDrain()
  }

  #ensureDrain(): Promise<void> {
    if (!this.#running) {
      this.#running = this.#drain().finally(() => {
        this.#running = null
        // Race guard: if a caller enqueued after the loop observed an empty
        // queue but before #running was cleared, keep draining.
        if (this.#pending.length > 0) void this.#ensureDrain()
      })
    }
    return this.#running
  }

  async #drain(): Promise<void> {
    while (this.#pending.length > 0) {
      const batch = this.#pending
      this.#pending = []

      try {
        const { decoded, blocked } = await this.codec.decodeMany(
          this.documentId,
          batch
        )
        if (decoded.length > 0) this.onDecoded(decoded)
        this.#setBlocked(blocked)
      } catch (e) {
        this.onError(e)
        this.#setBlocked(true)
      }
    }
  }

  #setBlocked(blocked: boolean): void {
    if (this.#blocked === blocked) return
    this.#blocked = blocked
    this.onBlockedChanged(blocked)
  }
}
