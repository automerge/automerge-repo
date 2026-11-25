import {
  idBytes,
  sedimentreeId,
  type CommitId,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction"
import type { KeyhiveAccess } from "@automerge/subduction/slim"
import {
  ChangeId,
  CiphertextStore,
  DocumentId,
  Keyhive,
  type ContactCard,
  type Event as KeyhiveEvent,
  type GroupId,
  type Identifier,
  type IndividualId,
  type MemberedId,
  type Membership,
  type Power,
  type SignedDelegation,
  type SignedRevocation,
  type Signer,
  type Summary,
} from "@keyhive/keyhive/slim"
import { keyhiveAccess } from "./keyhiveAccess.js"
import { log } from "./logging.js"
import { PromiseQueue } from "./PromiseQueue.js"
import { KeyhiveStorage } from "./KeyhiveStorage.js"
import { freeAfter, freeAll } from "./utilities.js"

/** The heads of a document's history in storage. */
export type StoredHeads = (id: SedimentreeId) => Promise<readonly CommitId[]>

/** A keyhive instance and its storage. API methods are a subset of the
 * underlying `Keyhive` API. All keyhive calls are serialized in a
 * `PromiseQueue`.
 * */
export class LocalKeyhive {
  readonly queue = new PromiseQueue()
  readonly #keyhive: Keyhive
  #events: Uint8Array[] = []
  #prekeysChanged = false
  #persistQueued = false
  #changeCounter = 0
  #access?: KeyhiveAccess

  private constructor(
    keyhive: Keyhive,
    readonly storage: KeyhiveStorage,
    private readonly storedHeads: StoredHeads
  ) {
    this.#keyhive = keyhive
  }

  /**
   * Load the state saved in `adapter` or create a new keyhive. `adapter`
   * stores this replica's prekey secrets unencrypted and must be treated
   * as secret. A revocation records the `storedHeads` of the documents it
   * affects.
   */
  static async open(
    signer: Signer,
    adapter: SubductionStorageAdapterInterface,
    storedHeads: StoredHeads
  ): Promise<LocalKeyhive> {
    const storage = new KeyhiveStorage(adapter)
    let self: LocalKeyhive | undefined
    const early: KeyhiveEvent[] = []
    const onEvent = (event: KeyhiveEvent) => {
      if (self) {
        self.#onEvent(event)
      } else {
        early.push(event)
      }
    }
    const store = CiphertextStore.newInMemory()
    const archive = await storage.loadArchive()
    const keyhive = archive
      ? await freeAfter(archive, a => a.tryToKeyhive(store, signer, onEvent))
      : await Keyhive.init(signer, store, onEvent)
    await storage.loadPrekeySecrets(keyhive)
    const saved = await storage.ingestEvents(keyhive)
    self = new LocalKeyhive(keyhive, storage, storedHeads)
    for (const event of early) self.#onEvent(event)
    if (!saved) await storage.saveArchive(keyhive)
    await storage.savePrekeySecrets(keyhive)
    return self
  }

  /** This replica's keyhive identity. */
  get id(): IndividualId {
    return this.#keyhive.id
  }

  /** A contact card with a new prekey. */
  contactCard(): Promise<ContactCard> {
    return this.#change(keyhive => keyhive.contactCard())
  }

  /** The contact card this replica already has. */
  getExistingContactCard(): Promise<ContactCard> {
    return this.queue.run(() => this.#keyhive.getExistingContactCard())
  }

  /** Add another replica's keys. A card whose owner is known is ignored. */
  receiveContactCard(card: ContactCard): Promise<IndividualId> {
    return this.#change(async keyhive => {
      if (await keyhive.hasIndividual(card.individualId)) {
        return card.individualId
      }
      return keyhive.receiveContactCard(card)
    })
  }

  /** Create a group with this replica as its owner. */
  generateGroup(coparents: Identifier[]): Promise<GroupId> {
    return this.#change(keyhive => keyhive.generateGroup(coparents))
  }

  /** Grant an agent that keyhive already knows access to a group or document. */
  addMember(
    id: Identifier,
    membered: MemberedId,
    power: Power
  ): Promise<SignedDelegation> {
    return this.#change(keyhive => keyhive.addMember(id, membered, power))
  }

  /**
   * Revoke a member of a group or document. Each document the revocation
   * affects first has keyhive's content heads set to its stored heads, so
   * the revocation records them: for a group, each document this replica can
   * reach. A document whose heads cannot be read is skipped. Writes not
   * stored yet are not covered.
   */
  revokeMember(
    id: Identifier,
    retainAllOtherMembers: boolean,
    membered: MemberedId
  ): Promise<SignedRevocation[]> {
    return this.#change(async keyhive => {
      const docs = membered.isDocument
        ? [
            await freeAfter(membered.toIdentifier(), doc =>
              sedimentreeId(doc.toBytes())
            ),
          ]
        : await reachableIds(keyhive)
      for (const doc of docs) {
        try {
          await this.#setContentHeads(doc)
        } catch (error) {
          log.debug("[LocalKeyhive] no content heads for", doc, error)
        }
      }
      return keyhive.revokeMember(id, retainAllOtherMembers, membered)
    })
  }

  /** The documents this replica has access to. */
  reachableDocs(): Promise<Summary[]> {
    return this.queue.run(() => this.#keyhive.reachableDocs())
  }

  /**
   * The individuals with access to a document, directly or through groups,
   * with their power. Any whose contact card this replica has not received
   * are left out.
   */
  docMemberCapabilities(doc: DocumentId): Promise<Membership[]> {
    return this.queue.run(() => this.#keyhive.docMemberCapabilities(doc))
  }

  /** `id`'s access to a document. `undefined` if it has none. */
  accessForDoc(id: Identifier, doc: DocumentId): Promise<Power | undefined> {
    return this.queue.run(() => this.#keyhive.accessForDoc(id, doc))
  }

  /**
   * Write buffered events and, if they changed, the prekey secrets. Call from
   * inside a {@link queue} task so that key material reaches storage before
   * the ciphertext that depends on it. If a write fails, it's retained
   * for the next call.
   */
  async persist(): Promise<void> {
    const events = this.#events
    const prekeysChanged = this.#prekeysChanged
    this.#events = []
    this.#prekeysChanged = false
    try {
      if (events.length) await this.storage.saveEvents(events)
      if (prekeysChanged) await this.storage.savePrekeySecrets(this.#keyhive)
    } catch (error) {
      this.#events = [...events, ...this.#events]
      this.#prekeysChanged ||= prekeysChanged
      throw error
    }
  }

  /** @internal The keyhive itself. Call it only inside {@link queue}. */
  keyhive(): Keyhive {
    return this.#keyhive
  }

  /**
   * The keyhive as the `KeyhiveAccess` that Subduction's `keyhive` option
   * expects. Each method except the synchronous `id` and `isCurrentArchive`
   * runs in {@link queue} so Subduction's
   * keyhive calls do not overlap this package's. A queue task must never
   * wait for a Subduction call that reaches keyhive or each will wait for
   * the other. Every call returns the same object.
   */
  access(): KeyhiveAccess {
    if (this.#access) return this.#access
    const access = keyhiveAccess(this.#keyhive)
    const queued = Object.entries(access).map(([name, method]) => {
      if (name === "id" || name === "isCurrentArchive") return [name, method]
      const call = method as (...args: unknown[]) => Promise<unknown>
      return [name, (...args: unknown[]) => this.queue.run(() => call(...args))]
    })
    this.#access = Object.fromEntries(queued) as KeyhiveAccess
    return this.#access
  }

  /**
   * Increases each time keyhive reports an event to this replica. Compare it
   * with an earlier value to detect a change. It is not a count of keyhive's
   * events.
   */
  get changeCounter(): number {
    return this.#changeCounter
  }

  /** Run a change to keyhive state, then store the events it produced. */
  #change<T>(change: (keyhive: Keyhive) => Promise<T>): Promise<T> {
    return this.queue.run(async () => {
      const result = await change(this.#keyhive)
      await this.persist()
      return result
    })
  }

  /** Set keyhive's content heads for `id` to its stored heads. */
  async #setContentHeads(id: SedimentreeId): Promise<void> {
    const heads = (await this.storedHeads(id)).map(
      head => new ChangeId(idBytes(head))
    )
    await freeAfter(new DocumentId(idBytes(id)), doc =>
      this.#keyhive.setContentHeads(doc, heads)
    ).finally(() => freeAll(heads))
  }

  /**
   * Called from inside keyhive so it only buffers and schedules. Frees
   * `event`.
   */
  #onEvent(event: KeyhiveEvent): void {
    this.#changeCounter++
    this.#events.push(event.toBytes())
    const variant = event.variant
    event.free()
    // A CGKA operation of our own can rotate our leaf key and its secret is
    // stored with the prekey secrets.
    if (
      variant === "PREKEY_ROTATED" ||
      variant === "PREKEYS_EXPANDED" ||
      variant === "CGKA_OPERATION"
    ) {
      this.#prekeysChanged = true
    }
    if (this.#persistQueued) return
    this.#persistQueued = true
    void this.queue
      .run(async () => {
        this.#persistQueued = false
        await this.persist()
      })
      .catch(error => log.error("[LocalKeyhive] persist failed:", error))
  }
}

/** The IDs of the documents `keyhive` can reach. Call inside the queue. */
export async function reachableIds(keyhive: Keyhive): Promise<SedimentreeId[]> {
  return (await keyhive.reachableDocs()).map(summary => {
    const document = summary.doc
    const docId = document.docId
    const id = sedimentreeId(docId.toBytes())
    freeAll([docId, document, summary])
    return id
  })
}
