import type { PeerId } from "@automerge/automerge-repo/slim"

/**
 * The repo peer ID for a verifying key, which is its base64 encoding followed
 * by "-" and `suffix` if `suffix` is not empty.
 */
export function peerIdFromVerifyingKey(
  verifyingKey: Uint8Array,
  suffix = ""
): PeerId {
  const peerId = btoa(String.fromCharCode(...verifyingKey))
  return (suffix === "" ? peerId : `${peerId}-${suffix}`) as PeerId
}

export function uint8ArrayToHex(arr: Uint8Array): string {
  return Array.from(arr)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16)
  }
  return bytes
}

/**
 * Apply `f` to `value`, then free `value`'s Wasm memory.
 *
 * Keyhive's Wasm objects are also freed when they are garbage collected. Free
 * them explicitly where they are created per record, per keyhive frame or per
 * document in a loop, or where they hold a large buffer, because Wasm memory
 * never shrinks once it has grown. Small objects created once per backend or
 * per application call are left to the collector.
 */
export async function freeAfter<T extends { free(): void }, R>(
  value: T,
  f: (value: T) => R | Promise<R>
): Promise<R> {
  try {
    return await f(value)
  } finally {
    value.free()
  }
}

/** Free the Wasm memory of each of `values`. */
export function freeAll(values: Iterable<{ free(): void }>): void {
  for (const value of values) value.free()
}

/**
 * Runs its task at most once at a time for each key. A request while it runs
 * makes it run once more afterwards, because the run in flight may predate
 * what prompted the request. The task must handle its own errors.
 */
export class Rerun<K = undefined> {
  /** Running keys and whether each was requested again. */
  readonly #again = new Map<K, boolean>()

  constructor(private readonly task: (key: K) => Promise<void>) {}

  run(...args: [K] extends [undefined] ? [] : [key: K]): void {
    this.#run(args[0] as K)
  }

  #run(key: K): void {
    if (this.#again.has(key)) {
      this.#again.set(key, true)
      return
    }
    this.#again.set(key, false)
    void this.task(key).finally(() => {
      const again = this.#again.get(key)
      this.#again.delete(key)
      if (again) this.#run(key)
    })
  }
}
