import {
  idBytes,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import {
  DocumentId,
  Identifier,
  IndividualId,
  MemberedId,
  Power,
} from "@keyhive/keyhive/slim"
import type { LocalKeyhive } from "./LocalKeyhive.js"
import { log } from "./logging.js"
import { relayKey, relayKeyBytes, type RelayKey } from "./relayKey.js"
import { reachableIds } from "./RepoKeyhive.js"
import { freeAfter, freeAll, Rerun } from "./utilities.js"

/**
 * Documents granted in one queue task so other keyhive calls can run between
 * them.
 */
const GRANTS_PER_TASK = 256

/**
 * Grants Relay to the configured sync servers on every document this replica
 * can reach once keyhive knows each server. That includes documents deleted
 * locally, which keyhive still reaches. Nothing about the relays is stored.
 * Configure them again on each start.
 */
export class RelayGrants {
  readonly #relays = new Set<RelayKey>()
  /** Relays granted on every document in {@link #documents}. */
  readonly #granted = new Set<RelayKey>()
  /** Documents on which every relay in {@link #granted} has been granted. */
  readonly #documents = new Set<SedimentreeId>()
  /**
   * The `local.changeCounter` that the last finished pass covered.
   * `undefined` if one of its grants failed, in which case the next frame
   * starts another pass.
   */
  #passCounter?: number
  readonly #passes = new Rerun(() =>
    this.#pass().catch(error =>
      log.error("[RelayGrants] relay grants failed:", error)
    )
  )
  #closed = false

  /** Throws if one of `relays` is not 32 bytes. */
  constructor(
    private readonly local: LocalKeyhive,
    relays: readonly Uint8Array[]
  ) {
    for (const relay of relays) this.#relays.add(relayKey(relay))
    this.#schedule()
  }

  /** Throws if `verifyingKey` is not 32 bytes. */
  add(verifyingKey: Uint8Array): void {
    const key = relayKey(verifyingKey)
    if (this.#relays.has(key)) return
    this.#relays.add(key)
    this.#schedule()
  }

  /**
   * Grant Relay on the new document `id` to each configured relay that
   * keyhive knows. Call inside the queue.
   */
  async grantNew(id: SedimentreeId): Promise<void> {
    for (const relay of await this.#known()) await this.#grant(relay, [id])
    this.#documents.add(id)
  }

  /**
   * Start a pass that grants Relay to relays keyhive has learned of and on
   * documents this replica has been added to. Call after every keyhive frame
   * since a contact card can make a relay known without the frame being
   * reported as ingested. No-op if keyhive has not changed since the last
   * pass.
   */
  retry(): void {
    if (this.local.changeCounter === this.#passCounter) return
    this.#schedule()
  }

  close(): void {
    this.#closed = true
  }

  #schedule(): void {
    if (this.#closed || this.#relays.size === 0) return
    this.#passes.run()
  }

  /**
   * Grant each known relay not yet in {@link #granted} on every reachable
   * document and every known relay on each reachable document not yet in
   * {@link #documents}. A relay that already has access is skipped. Each
   * batch of grants is persisted before the next queue task. If a relay's
   * batch fails, its documents are granted one at a time, and a document
   * whose grant fails gets every known relay again on the next pass.
   */
  async #pass(): Promise<void> {
    if (this.#closed) return
    const { counter, reachable, known } = await this.local.queue.run(
      async () => ({
        counter: this.local.changeCounter,
        reachable: await reachableIds(this.local.keyhive),
        known: await this.#known(),
      })
    )
    const all = [...known]
    const added = all.filter(relay => !this.#granted.has(relay))
    const work = reachable
      .map(id => ({ id, relays: this.#documents.has(id) ? added : all }))
      .filter(({ relays }) => relays.length > 0)
    const failed = new Set<SedimentreeId>()
    let covered = counter
    let changedElsewhere = false
    for (let at = 0; at < work.length; at += GRANTS_PER_TASK) {
      if (this.#closed) return
      await this.local.queue.run(async () => {
        if (this.local.changeCounter !== covered) changedElsewhere = true
        const byRelay = new Map<RelayKey, SedimentreeId[]>()
        for (const { id, relays } of work.slice(at, at + GRANTS_PER_TASK)) {
          for (const relay of relays) {
            const ids = byRelay.get(relay)
            if (ids) ids.push(id)
            else byRelay.set(relay, [id])
          }
        }
        for (const [relay, ids] of byRelay) {
          try {
            await this.#grant(relay, ids)
          } catch {
            for (const id of ids) {
              try {
                await this.#grant(relay, [id])
              } catch (error) {
                failed.add(id)
                log.error("[RelayGrants] relay grant failed:", id, error)
              }
            }
          }
        }
        await this.local.persist()
        covered = this.local.changeCounter
      })
    }
    for (const relay of added) this.#granted.add(relay)
    for (const id of reachable) {
      if (failed.has(id)) this.#documents.delete(id)
      else this.#documents.add(id)
    }
    this.#passCounter =
      failed.size > 0 ? undefined : changedElsewhere ? counter : covered
  }

  /** The configured relays that keyhive knows. Call inside the queue. */
  async #known(): Promise<Set<RelayKey>> {
    const known = new Set<RelayKey>()
    for (const relay of this.#relays) {
      const id = new IndividualId(relayKeyBytes(relay))
      if (await freeAfter(id, i => this.local.keyhive.hasIndividual(i))) {
        known.add(relay)
      }
    }
    return known
  }

  /**
   * Grant Relay to `relay` on each of `ids` where it has no access yet as one
   * batch. Keyhive must know `relay`. Grants nothing if any grant fails. Call
   * inside the queue.
   */
  async #grant(relay: RelayKey, ids: readonly SedimentreeId[]): Promise<void> {
    const keyhive = this.local.keyhive
    const documents = ids.map(id => new DocumentId(idBytes(id)))
    const membered: MemberedId[] = []
    try {
      await freeAfter(new Identifier(relayKeyBytes(relay)), async member => {
        for (const document of documents) {
          const access = await keyhive.accessForDoc(member, document)
          if (access) access.free()
          else membered.push(MemberedId.document(document))
        }
        if (membered.length === 0) return
        const delegations = await freeAfter(Power.relay(), power =>
          keyhive.addMemberToEach(member, membered, power)
        )
        freeAll(delegations)
      })
    } finally {
      freeAll([...membered, ...documents])
    }
  }
}
