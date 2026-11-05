import type { SedimentreeId } from "@automerge/automerge-repo/sedimentree"

/** How one document syncs with one peer. */
export interface SyncRule {
  /** The peer may read and write the document and exchange its ephemeral
   * messages with us. When false, nothing about the document moves either way. */
  readonly access: boolean
  /** We start sync rounds for the document with the peer. When false we still
   * answer its requests and push changes once it has asked. Needs `access`. */
  readonly announce: boolean
}

/** A changing rule: `value` is read on every check; `subscribe` reports changes. */
export interface SyncRuleSignal {
  readonly value: SyncRule
  subscribe(callback: (rule: SyncRule) => void): () => void
}

/** Called once per document and peer, when first needed; the signal is kept
 * until the backend closes. */
export type SyncPolicy = (
  documentId: SedimentreeId,
  peerId: string
) => SyncRuleSignal | Promise<SyncRuleSignal>

export const syncAll: SyncRule = Object.freeze({ access: true, announce: true })

/** A settable {@link SyncRuleSignal}. */
export function syncRule(
  initial: SyncRule
): SyncRuleSignal & { set(rule: SyncRule): void } {
  let current = initial
  const listeners = new Set<(rule: SyncRule) => void>()
  return {
    get value() {
      return current
    },
    set(rule) {
      if (rule.access === current.access && rule.announce === current.announce)
        return
      current = rule
      for (const listener of [...listeners]) listener(rule)
    },
    subscribe(callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
}

const announces = (rule: SyncRule) => rule.access && rule.announce

/**
 * The backend's view of a {@link SyncPolicy}. For open documents it asks once
 * per pair, keeps the signal and reports pairs that become announceable;
 * otherwise it asks on every check and keeps nothing, so peers can't grow it.
 */
export class SyncRules {
  readonly #policy?: SyncPolicy
  readonly #isOpen: (tree: SedimentreeId) => boolean
  readonly #onAnnounce: (tree: SedimentreeId, peer: string) => void
  readonly #entries = new Map<
    string,
    SyncRuleSignal | Promise<SyncRuleSignal>
  >()
  readonly #unsubscribes = new Map<string, () => void>()
  #closed = false

  constructor(
    policy: SyncPolicy | undefined,
    isOpen: (tree: SedimentreeId) => boolean,
    onAnnounce: (tree: SedimentreeId, peer: string) => void
  ) {
    this.#policy = policy
    this.#isOpen = isOpen
    this.#onAnnounce = onAnnounce
  }

  /** Synchronous once the pair's signal is known. A failed policy call
   * rejects and is retried on the next check. */
  rule(tree: SedimentreeId, peer: string): SyncRule | Promise<SyncRule> {
    if (!this.#policy) return syncAll
    const key = `${tree}/${peer}`
    let entry = this.#entries.get(key)
    if (!entry) {
      try {
        entry = this.#policy(tree, peer)
      } catch (cause) {
        return Promise.reject(cause)
      }
      if (entry instanceof Promise && this.#isOpen(tree)) {
        // A late answer from before a close and reopen must not replace or
        // delete the current entry.
        const pending: Promise<SyncRuleSignal> = entry.then(
          signal =>
            this.#entries.get(key) === pending
              ? this.#watch(key, tree, peer, signal)
              : signal,
          cause => {
            if (this.#entries.get(key) === pending) this.#entries.delete(key)
            throw cause
          }
        )
        entry = pending
        this.#entries.set(key, entry)
      } else if (!(entry instanceof Promise))
        this.#watch(key, tree, peer, entry)
    }
    return entry instanceof Promise ? entry.then(s => s.value) : entry.value
  }

  /** Forget a document's pairs once it is no longer open. */
  forgetTree(tree: SedimentreeId): void {
    for (const key of this.#entries.keys())
      if (key.startsWith(`${tree}/`)) this.#forget(key)
  }

  close(): void {
    this.#closed = true
    for (const key of [...this.#entries.keys()]) this.#forget(key)
  }

  #forget(key: string): void {
    this.#entries.delete(key)
    this.#unsubscribes.get(key)?.()
    this.#unsubscribes.delete(key)
  }

  #watch(
    key: string,
    tree: SedimentreeId,
    peer: string,
    signal: SyncRuleSignal
  ): SyncRuleSignal {
    // The document may have closed while an async policy answered.
    if (this.#closed || !this.#isOpen(tree)) {
      this.#entries.delete(key)
      return signal
    }
    this.#entries.set(key, signal)
    // A callback during subscribe compares against this and is a no-op.
    let last = signal.value
    this.#unsubscribes.set(
      key,
      signal.subscribe(rule => {
        if (!announces(last) && announces(rule)) this.#onAnnounce(tree, peer)
        last = rule
      })
    )
    return signal
  }
}
