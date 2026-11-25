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

/** The keyhive operations on one document (`handle.keyhive()`). */
export class DocKeyhive {
  constructor(
    private readonly local: LocalKeyhive,
    private readonly id: SedimentreeId,
    /** The document's session. `undefined` once it's closed. */
    private readonly session: () => KeyhiveSession | undefined
  ) {}

  /** The document's keyhive ID. */
  get documentId(): DocumentId {
    return new DocumentId(idBytes(this.id))
  }

  /** Grant access to an agent that keyhive already knows. */
  async addMember(id: Identifier, power: Power): Promise<void> {
    await this.local.addMember(id, this.#memberedId(), power)
  }

  /** Receive `card`, then grant access to its owner. */
  async addMemberFromContactCard(
    card: ContactCard,
    power: Power
  ): Promise<void> {
    await this.local.receiveContactCard(card)
    await this.local.addMember(card.id, this.#memberedId(), power)
  }

  /**
   * Revoke a member's access. The revocation records the heads of the
   * document's stored history. Writes not stored yet, including those
   * waiting to be encrypted, are not covered.
   */
  async revokeMember(id: Identifier): Promise<void> {
    await this.local.revokeMember(id, true, this.#memberedId())
  }

  /**
   * The individuals with access to the document, directly or through groups,
   * with their power. Any whose contact card this replica has not received
   * are left out.
   */
  members(): Promise<Membership[]> {
    return this.local.docMemberCapabilities(this.documentId)
  }

  /** `id`'s access to the document. `undefined` if it has none. */
  accessFor(id: Identifier): Promise<Power | undefined> {
    return this.local.accessForDoc(id, this.documentId)
  }

  /** This replica's access to the document. */
  myAccess(): Promise<Power | undefined> {
    return this.accessFor(new Identifier(this.local.id.toBytes()))
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
