import {
  BackendError,
  idBytes,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import {
  DocumentId,
  Identifier,
  MemberedId,
  type ContactCard,
  type Membership,
  type Power,
} from "@keyhive/keyhive/slim"
import type { KeyhiveSession } from "./KeyhiveSession.js"
import type { LocalKeyhive } from "./LocalKeyhive.js"
import {
  receiveContactCard,
  setContentHeads,
  type StoredHeads,
} from "./RepoKeyhive.js"

/** The keyhive operations on one document (`handle.keyhive()`). */
export class DocKeyhive {
  constructor(
    private readonly local: LocalKeyhive,
    private readonly id: SedimentreeId,
    private readonly storedHeads: StoredHeads,
    /** The document's session. `undefined` once it's closed. */
    private readonly session: () => KeyhiveSession | undefined
  ) {}

  /** The document's keyhive ID. */
  get documentId(): DocumentId {
    return new DocumentId(idBytes(this.id))
  }

  /** Grant access to an agent that keyhive already knows. */
  addMember(id: Identifier, power: Power): Promise<void> {
    return this.local.queue.run(async () => {
      await this.local.keyhive.addMember(id, this.#memberedId(), power)
      await this.local.persist()
    })
  }

  /** Receive `card`, then grant access to its owner. */
  addMemberFromContactCard(card: ContactCard, power: Power): Promise<void> {
    return this.local.queue.run(async () => {
      await receiveContactCard(this.local.keyhive, card)
      await this.local.keyhive.addMember(card.id, this.#memberedId(), power)
      await this.local.persist()
    })
  }

  /**
   * Revoke a member's access. The revocation records the heads of the
   * document's stored history. Writes not stored yet, including those
   * waiting to be encrypted, are not covered.
   */
  revokeMember(id: Identifier): Promise<void> {
    return this.local.queue.run(async () => {
      await setContentHeads(this.local, this.storedHeads, this.id)
      await this.local.keyhive.revokeMember(id, true, this.#memberedId())
      await this.local.persist()
    })
  }

  /**
   * The individuals with access to the document, directly or through groups,
   * with their power. Any whose contact card this replica has not received
   * are left out.
   */
  members(): Promise<Membership[]> {
    return this.local.queue.run(() =>
      this.local.keyhive.docMemberCapabilities(this.documentId)
    )
  }

  /** `id`'s access to the document. `undefined` if it has none. */
  accessFor(id: Identifier): Promise<Power | undefined> {
    return this.local.queue.run(() =>
      this.local.keyhive.accessForDoc(id, this.documentId)
    )
  }

  /** This replica's access to the document. */
  myAccess(): Promise<Power | undefined> {
    return this.accessFor(new Identifier(this.local.keyhive.id.toBytes()))
  }

  /** The number of received records for this document that cannot be decrypted yet. */
  get pendingCount(): number {
    const session = this.session()
    if (!session) throw documentClosed()
    return session.pendingCount
  }

  #memberedId(): MemberedId {
    return MemberedId.document(this.documentId)
  }
}

export function documentClosed(): BackendError {
  return new BackendError("extension", "closed", "The document is closed")
}
