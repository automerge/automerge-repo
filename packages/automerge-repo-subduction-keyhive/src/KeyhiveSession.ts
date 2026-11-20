import {
  BackendError,
  recordHead,
  type CommitId,
  type SedimentreeId,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import type {
  EphemeralEnvelope,
  SubductionEvent,
  SubductionSession,
} from "@automerge/automerge-repo-subduction"
import { Encrypted } from "@keyhive/keyhive/slim"
import {
  ciphertextRef,
  matchingChanges,
  recordRef,
  storedRef,
  type ChangesIn,
  type ContentRef,
  type DocumentRefs,
} from "./DocumentRefs.js"
import type { LocalKeyhive } from "./LocalKeyhive.js"
import type { StoredHeads } from "./RepoKeyhive.js"
import { log } from "./logging.js"
import { PromiseQueue } from "./PromiseQueue.js"
import { freeAfter } from "./utilities.js"

/** Decrypts one block and those of its ancestors that its keys can open. */
export type CausalDecrypt = (
  encrypted: Encrypted,
  load: (ref: ContentRef) => Promise<Uint8Array | undefined> | undefined
) => Promise<{ ref: ContentRef; plaintext: Uint8Array }[]>

/** A record without its ciphertext, which the inner backend has stored. */
export type PendingRecord = SedimentreeRecord extends infer R
  ? R extends SedimentreeRecord
    ? Omit<R, "blob">
    : never
  : never

/** Reads a pending record's ciphertext from the inner backend. */
export type LoadBlob = (
  record: PendingRecord
) => Promise<Uint8Array | undefined>

export function predecessors(record: PendingRecord): readonly CommitId[] {
  return record.kind === "commit" ? record.parents : record.boundary
}

export function pendingHead(record: PendingRecord): CommitId {
  return record.kind === "commit" ? record.id : record.head
}

/** What a session requires from its backend. */
export interface SessionContext {
  readonly local: LocalKeyhive
  readonly storedHeads: StoredHeads
  readonly decrypt: CausalDecrypt
  readonly loadBlob: LoadBlob
  /** Whether this replica's access to the document is at most Relay. */
  readonly atMostRelay: () => Promise<boolean>
  /** Shared by every session of the document. */
  readonly refs: DocumentRefs
  readonly changesIn: ChangesIn
  readonly onClose: () => void
}

/** An async iterable that is written to by calling `push`. */
class EventChannel implements AsyncIterable<SubductionEvent> {
  readonly #buffer: SubductionEvent[] = []
  #wake?: () => void
  #done = false

  push(event: SubductionEvent): void {
    this.#buffer.push(event)
    this.#wake?.()
  }

  finish(): void {
    this.#done = true
    this.#wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SubductionEvent> {
    for (;;) {
      const event = this.#buffer.shift()
      if (event) yield event
      else if (this.#done) return
      else await new Promise<void>(resolve => (this.#wake = resolve))
    }
  }
}

/** Pending records tried in one task of a retry. */
const RETRY_BATCH = 32

/**
 * Presents an inner session's ciphertext as plaintext. A record that cannot be
 * decrypted yet stays pending here and consumers see it only once it can be.
 * The ciphertext is in the inner backend's storage. Nothing here needs to
 * be persisted.
 */
export class KeyhiveSession implements SubductionSession {
  readonly #events = new EventChannel()
  /** Serializes handling of inner events with retries. */
  readonly #serial = new PromiseQueue()
  /**
   * Records by the content ref in their ciphertext header, which is how
   * causal decryption traverses them. A commit and the fragment at its head
   * have different refs and are both kept.
   */
  readonly #pending = new Map<ContentRef, PendingRecord>()
  /**
   * Ciphertext of pending records that have not been tried yet. After a
   * failed attempt, it is read from the inner backend when needed.
   */
  readonly #blobs = new Map<ContentRef, Uint8Array>()
  /**
   * Predecessors of every record emitted to the consumer or written by it,
   * by head.
   */
  readonly #visible = new Map<CommitId, readonly CommitId[]>()
  /**
   * Fragments the consumer can already read. A record at a commit one of
   * them contains is not kept pending. What each contains is in the
   * document's `refs.fragments`.
   */
  readonly #released = new Set<ContentRef>()
  /**
   * Records emitted to the consumer, dropped, or written by the consumer.
   * The inner session can deliver a record again but another copy is not
   * decrypted again.
   */
  readonly #handled = new Set<ContentRef>()
  #loaded = false
  #atMostRelay: boolean | undefined
  /** Repo has a readable snapshot and no longer uses markers. */
  #ready = false
  #sequence = 0

  constructor(
    readonly id: SedimentreeId,
    private readonly inner: SubductionSession,
    private readonly context: SessionContext
  ) {
    void this.#forwardInnerEvents()
  }

  /** This replica's keyhive, which the `keyhive` handle extension reaches through the session. */
  get local(): LocalKeyhive {
    return this.context.local
  }

  /** For the `keyhive` handle extension. */
  get storedHeads(): StoredHeads {
    return this.context.storedHeads
  }

  get events(): AsyncIterable<SubductionEvent> {
    return this.#events
  }

  /** Repo has a readable snapshot of the document. */
  get ready(): boolean {
    return this.#ready
  }

  /** The number of records that are waiting for keys. */
  get pendingCount(): number {
    return this.#pending.size
  }

  publishEphemeral(message: EphemeralEnvelope): Promise<void> {
    return this.inner.publishEphemeral(message)
  }

  markReady(): void {
    this.#ready = true
    this.inner.markReady()
  }

  async close(): Promise<void> {
    try {
      await this.inner.close()
    } finally {
      this.context.onClose()
    }
  }

  /**
   * Try the pending records again, after keyhive state has changed. Each
   * batch is a separate task. Records that arrive in the meanwhile are
   * handled between batches instead of after every pending record. A replica
   * with at most Relay access does not retry.
   */
  async retry(): Promise<void> {
    const refs = await this.#serial.run(async () => {
      this.#atMostRelay = undefined
      return (await this.#isAtMostRelay()) ? [] : this.#newestFirst()
    })
    for (let i = 0; i < refs.length; i += RETRY_BATCH) {
      await this.#serial.run(() =>
        this.#release(refs.slice(i, i + RETRY_BATCH))
      )
    }
  }

  async #forwardInnerEvents(): Promise<void> {
    let failure: BackendError | undefined
    const fail = (error: unknown) => {
      if (failure) return
      log.error("[KeyhiveSession] inner session failed:", error)
      failure = new BackendError("open", "io", String(error), false, {
        cause: error,
      })
    }
    try {
      for await (const event of this.inner.events) {
        if (failure) break
        // Queued so that every event that arrives during a retry batch is
        // handled before the next batch, in order.
        void this.#serial.run(async () => {
          if (!failure) await this.#handle(event).catch(fail)
        })
      }
    } catch (error) {
      fail(error)
    }
    // After any retry in flight, so that nothing follows the final event.
    await this.#serial.run(async () => {
      if (failure) {
        this.#events.push({
          type: "failure",
          sequence: ++this.#sequence,
          error: failure,
        })
      }
      this.#pending.clear()
      this.#blobs.clear()
      this.#events.finish()
    })
  }

  async #handle(event: SubductionEvent): Promise<void> {
    switch (event.type) {
      case "records": {
        // Only new records are tried. Causal decryption of each one reaches its
        // older pending ancestors and other pending records wait for new
        // keyhive state.
        const admitted = event.records.flatMap(r => this.#admit(r))
        if (this.#loaded) await this.#releaseOrKeep(admitted)
        break
      }
      case "local-load-complete":
        await this.#releaseOrKeep(this.#newestFirst())
        this.#loaded = true
        this.#events.push({ ...event, marker: this.#marker() })
        break
      case "history-marker":
        this.#events.push({ ...event, marker: this.#marker() })
        break
      case "synchronized":
        this.#events.push({
          ...event,
          result: { ...event.result, marker: this.#marker() },
        })
        break
      default:
        this.#events.push(event)
    }
  }

  /**
   * Own writes become visible at once. Returns `[ref]` if the record is now
   * pending and `[]` for an own write, a record already pending or handled,
   * a record contained by a released fragment, a blob that is not a keyhive
   * ciphertext, or a commit whose ciphertext points to another ref. That
   * check comes first so a forged record cannot take a genuine one's ref. A
   * fragment's ref is a hash of its plaintext and is checked once decrypted.
   */
  #admit(record: SedimentreeRecord): ContentRef[] {
    let ref: ContentRef
    try {
      ref = ciphertextRef(record.blob)
    } catch (error) {
      log.warn(
        "[KeyhiveSession] dropping a record that is not keyhive ciphertext:",
        error
      )
      return []
    }
    if (record.kind === "commit" && ref !== recordRef(record)) {
      log.warn("[KeyhiveSession] dropping a commit encrypted under another ref")
      return []
    }
    if (this.#handled.has(ref)) return []
    if (this.context.refs.isOwnWrite(ref)) {
      this.context.refs.forgetOwnWrite(ref)
      this.#handled.add(ref)
      if (record.kind === "fragment") this.#released.add(ref)
      this.#see(record)
      return []
    }
    if (this.#pending.has(ref)) return []
    if (this.#covered(recordHead(record))) return []
    const { blob, ...pending } = record
    this.#pending.set(ref, pending)
    this.#blobs.set(ref, blob)
    return [ref]
  }

  /**
   * If access is above Relay, release `refs`. Otherwise, keep them pending
   * without their ciphertext. They are read from the inner backend if
   * access is increased.
   */
  async #releaseOrKeep(refs: readonly ContentRef[]): Promise<void> {
    if (!(await this.#isAtMostRelay())) return this.#release(refs)
    for (const ref of refs) this.#blobs.delete(ref)
  }

  async #isAtMostRelay(): Promise<boolean> {
    this.#atMostRelay ??= await this.context.atMostRelay()
    return this.#atMostRelay
  }

  /**
   * Try to decrypt `refs` and emit whatever that opens. Every fragment that
   * opens is recorded. Later writes can list it as a predecessor.
   */
  async #release(refs: readonly ContentRef[]): Promise<void> {
    const released: SedimentreeRecord[] = []
    for (const ref of refs) {
      const record = this.#pending.get(ref)
      if (!record) continue
      for (const block of await this.#tryDecrypt(ref)) {
        const opened = this.#pending.get(block.ref)
        if (!opened) continue
        this.#pending.delete(block.ref)
        this.#blobs.delete(block.ref)
        const plaintext = { ...opened, blob: block.plaintext }
        const changes =
          recordRef(plaintext) === block.ref
            ? matchingChanges(plaintext, this.context.changesIn)
            : undefined
        if (!changes) {
          log.warn(
            "[KeyhiveSession] dropping a record whose content does not match it"
          )
          continue
        }
        this.#handled.add(block.ref)
        if (opened.kind === "fragment") {
          this.context.refs.fragments.add(block.ref, opened.head, changes)
          this.#released.add(block.ref)
        }
        this.#see(opened)
        released.push(plaintext)
      }
    }
    for (const ref of refs) this.#blobs.delete(ref)
    if (released.some(r => r.kind === "fragment")) this.#dropCovered()
    if (released.length === 0) return
    this.#events.push({
      type: "records",
      sequence: ++this.#sequence,
      phase: this.#loaded ? "live" : "initial",
      records: released,
    })
    if (this.#loaded && !this.#ready) {
      this.#events.push({ type: "history-marker", marker: this.#marker() })
    }
  }

  /** Drop the pending records at commits that a released fragment contains. */
  #dropCovered(): void {
    for (const [ref, record] of this.#pending) {
      if (this.#covered(pendingHead(record))) {
        this.#pending.delete(ref)
        this.#blobs.delete(ref)
      }
    }
  }

  /**
   * Decrypt the pending record `ref` and the pending ancestors its keys
   * reach. A pending record whose ciphertext the inner backend no longer
   * stores, or has replaced with one under another ref, is dropped.
   * Both happen because sedimentree keeps one record per head and
   * minimization removes loose commits that a fragment covers.
   */
  async #tryDecrypt(
    ref: ContentRef
  ): Promise<{ ref: ContentRef; plaintext: Uint8Array }[]> {
    const gone: ContentRef[] = []
    const blob = async (pending: ContentRef) => {
      const found = await this.#blob(pending)
      if (!found) gone.push(pending)
      return found
    }
    try {
      const own = await blob(ref)
      if (!own) return []
      return await freeAfter(Encrypted.fromBytes(own), encrypted =>
        this.context.decrypt(encrypted, predecessor =>
          this.#pending.has(predecessor) ? blob(predecessor) : undefined
        )
      )
    } catch (error) {
      log.debug("[KeyhiveSession] record stays pending:", error)
      return []
    } finally {
      for (const pending of gone) this.#pending.delete(pending)
    }
  }

  /**
   * The ciphertext of the pending record `ref`. `undefined` if it is not
   * pending or the inner backend no longer stores it under `ref`.
   */
  async #blob(ref: ContentRef): Promise<Uint8Array | undefined> {
    const record = this.#pending.get(ref)
    if (!record) return undefined
    const kept = this.#blobs.get(ref)
    if (kept) return kept
    const stored = await this.context.loadBlob(record)
    return stored && storedRef(stored) === ref ? stored : undefined
  }

  /**
   * Record `record` as visible, unless it is a commit that a released
   * fragment contains. That would replace the fragment's entry, whose
   * predecessors are the fragment's boundary.
   */
  #see(record: PendingRecord): void {
    const head = pendingHead(record)
    if (record.kind === "commit" && this.#covered(head)) return
    this.#visible.set(head, predecessors(record))
  }

  /** Whether a released fragment contains `commit`. */
  #covered(commit: CommitId): boolean {
    return this.#releasedContaining(commit) !== undefined
  }

  /** The deepest released fragment that contains `commit`. */
  #releasedContaining(commit: CommitId): ContentRef | undefined {
    return this.context.refs.fragments.deepestContaining(commit, ref =>
      this.#released.has(ref)
    )
  }

  /**
   * Pending refs, listing first those whose head is not a predecessor of
   * another pending record.
   */
  #newestFirst(): ContentRef[] {
    const ancestors = new Set(
      [...this.#pending.values()].flatMap(r => predecessors(r))
    )
    const pending = [...this.#pending]
    return [
      ...pending.filter(([, r]) => !ancestors.has(pendingHead(r))),
      ...pending.filter(([, r]) => ancestors.has(pendingHead(r))),
    ].map(([ref]) => ref)
  }

  /**
   * The heads of the visible records that Repo can apply with all of their
   * history. A record cannot be applied if some ancestor is neither visible
   * nor in a released fragment, such as one still pending, one inside a
   * fragment still pending, or one dropped because its content did not match
   * its metadata. A marker containing such a record would never be satisfied.
   */
  #marker(): { sequence: number; heads: CommitId[] } {
    const children = new Map<CommitId, CommitId[]>()
    const unreadable: CommitId[] = []
    for (const [commit, predecessors] of this.#visible) {
      for (const predecessor of predecessors) {
        let known: CommitId | undefined = predecessor
        if (!this.#visible.has(predecessor)) {
          const fragment = this.#releasedContaining(predecessor)
          known = fragment && this.context.refs.fragments.head(fragment)
        }
        if (known === undefined) unreadable.push(commit)
        else {
          const siblings = children.get(known)
          if (siblings) siblings.push(commit)
          else children.set(known, [commit])
        }
      }
    }
    const blocked = new Set<CommitId>()
    for (let next = unreadable.pop(); next; next = unreadable.pop()) {
      if (blocked.has(next)) continue
      blocked.add(next)
      unreadable.push(...(children.get(next) ?? []))
    }
    const readable = [...this.#visible.keys()].filter(c => !blocked.has(c))
    const parents = new Set(readable.flatMap(c => this.#visible.get(c)!))
    const heads = readable.filter(c => !parents.has(c))
    return { sequence: ++this.#sequence, heads }
  }
}
