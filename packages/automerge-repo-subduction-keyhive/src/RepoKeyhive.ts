import {
  idBytes,
  sedimentreeId,
  type CommitId,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import {
  ChangeId,
  DocumentId,
  Identifier,
  MemberedId,
  type ContactCard,
  type GroupId,
  type Keyhive,
  type Membership,
  type Power,
  type Summary,
} from "@keyhive/keyhive/slim"
import type { LocalKeyhive } from "./LocalKeyhive.js"
import { log } from "./logging.js"
import { freeAfter, freeAll } from "./utilities.js"

/** The heads of a document's history in storage. */
export type StoredHeads = (id: SedimentreeId) => Promise<readonly CommitId[]>

/**
 * The keyhive operations that are not about one document, such as
 * contacts, groups, and reachable documents. Intended to
 * become `repo.keyhive` once Repo supports attributes.
 */
export class RepoKeyhive {
  constructor(
    private readonly local: LocalKeyhive,
    private readonly storedHeads: StoredHeads
  ) {}

  /** This replica's keyhive identity. */
  get id(): Identifier {
    return new Identifier(this.local.keyhive.id.toBytes())
  }

  /**
   * The card another replica needs in order to grant this one access.
   */
  contactCard(): Promise<ContactCard> {
    return this.local.queue.run(() =>
      this.local.keyhive.getExistingContactCard()
    )
  }

  /** Add another replica's keys so it can be added to groups and documents. */
  receiveContactCard(card: ContactCard): Promise<void> {
    return this.#change(() => receiveContactCard(this.local.keyhive, card))
  }

  /** Create a group with this replica as its owner. */
  createGroup(): Promise<GroupId> {
    return this.#change(() => this.local.keyhive.generateGroup([]))
  }

  /** Grant membership in `group` to an agent that keyhive already knows. */
  addGroupMember(group: GroupId, id: Identifier, power: Power): Promise<void> {
    return this.#change(() => this.#addMember(group, id, power))
  }

  /** Receive `card`, then grant its owner membership in `group`. */
  addGroupMemberFromContactCard(
    group: GroupId,
    card: ContactCard,
    power: Power
  ): Promise<void> {
    return this.#change(async () => {
      await receiveContactCard(this.local.keyhive, card)
      await this.#addMember(group, card.id, power)
    })
  }

  /**
   * Revoke a member of `group`. Each document this replica can reach first
   * has its content heads set to its stored heads, so the revocation records
   * them. A document whose heads cannot be read is skipped. Writes not stored
   * yet are not covered.
   */
  revokeGroupMember(group: GroupId, id: Identifier): Promise<void> {
    return this.#change(async () => {
      for (const doc of await reachableIds(this.local.keyhive)) {
        try {
          await setContentHeads(this.local, this.storedHeads, doc)
        } catch (error) {
          log.debug("[RepoKeyhive] no content heads for", doc, error)
        }
      }
      await this.local.keyhive.revokeMember(id, true, MemberedId.group(group))
    })
  }

  /**
   * Every individual with access to `group`, directly or through other
   * groups. One whose contact card this replica has not received is left out.
   */
  groupMembers(group: GroupId): Promise<Membership[]> {
    return this.local.queue.run(async () => {
      const found = await this.local.keyhive.getGroup(group)
      return found ? found.transitiveMembers() : []
    })
  }

  /** The documents this replica has access to. */
  reachableDocs(): Promise<Summary[]> {
    return this.local.queue.run(() => this.local.keyhive.reachableDocs())
  }

  async #addMember(
    group: GroupId,
    id: Identifier,
    power: Power
  ): Promise<void> {
    await this.local.keyhive.addMember(id, MemberedId.group(group), power)
  }

  /** Run a change to keyhive state, then store the events it produced. */
  #change<T>(change: () => Promise<T>): Promise<T> {
    return this.local.queue.run(async () => {
      const result = await change()
      await this.local.persist()
      return result
    })
  }
}

/**
 * Set keyhive's content heads for `id`, which its revocations record, to the
 * heads of the document's stored history. Call inside the queue.
 */
export async function setContentHeads(
  local: LocalKeyhive,
  storedHeads: StoredHeads,
  id: SedimentreeId
): Promise<void> {
  const heads = (await storedHeads(id)).map(head => new ChangeId(idBytes(head)))
  await freeAfter(new DocumentId(idBytes(id)), doc =>
    local.keyhive.setContentHeads(doc, heads)
  ).finally(() => freeAll(heads))
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

/** Receive `card` unless keyhive already knows its owner. Call inside the queue. */
export async function receiveContactCard(
  keyhive: Keyhive,
  card: ContactCard
): Promise<void> {
  if (!(await keyhive.hasIndividual(card.individualId))) {
    await keyhive.receiveContactCard(card)
  }
}
