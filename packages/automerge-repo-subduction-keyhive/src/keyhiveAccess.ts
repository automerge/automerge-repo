import type {
  KeyhiveAccess,
  KeyhiveAgentEvents,
} from "@automerge/subduction/slim"
import {
  Archive,
  ContactCard,
  Identifier,
  type Keyhive,
} from "@keyhive/keyhive/slim"
import { freeAfter } from "./utilities.js"

/**
 * The first bytes of every archive this version of keyhive writes (`KHIV` and
 * the format version).
 */
const ARCHIVE_HEADER = new Uint8Array([0x4b, 0x48, 0x49, 0x56, 4])

/**
 * Wrap `keyhive` as the byte-level `KeyhiveAccess` that Subduction's `keyhive`
 * option takes. Only bytes cross the boundary so Subduction and the keyhive
 * can be in separate Wasm modules.
 */
export function keyhiveAccess(keyhive: Keyhive): KeyhiveAccess {
  const keyhiveId = keyhive.id.toBytes()
  return {
    id: () => keyhiveId,

    contactCard: async () =>
      freeAfter(await keyhive.getExistingContactCard(), card => card.toBytes()),

    totalOps: async () =>
      freeAfter(await keyhive.stats(), stats => stats.totalOps),

    pendingEventHashes: () => keyhive.pendingEventHashes(),

    isKnownAgent: id => freeAfter(new Identifier(id), i => keyhive.hasAgent(i)),

    eventsForAgent: async id => {
      const principal = await freeAfter(new Identifier(id), i =>
        keyhive.getPrincipal(i)
      )
      return freeAfter(principal, p => keyhive.eventsForAgent(p))
    },

    allAgentEvents: async () =>
      freeAfter(
        await keyhive.allAgentEvents(),
        (all): KeyhiveAgentEvents => ({
          events: all.events,
          membershipSources: all.membershipSources,
          prekeySources: all.prekeySources,
          cgkaSources: all.cgkaSources,
          agentMembershipSources: all.agentMembershipSources,
          agentPrekeySources: all.agentPrekeySources,
          agentCgkaSources: all.agentCgkaSources,
          explanations: all.explanations,
        })
      ),

    signBytes: async payload =>
      freeAfter(await keyhive.trySign(payload), signed => signed.toBytes()),

    ingestEvents: events => keyhive.ingestEventsBytes(events),

    // A card's bytes are its prekey operation's event bytes.
    receiveContactCard: async card => {
      const id = await freeAfter(ContactCard.fromBytes(card), c =>
        keyhive.receiveContactCard(c)
      )
      id.free()
      return card
    },

    toArchive: async () =>
      freeAfter(await keyhive.toArchive(), archive => archive.toBytes()),

    isCurrentArchive: archive =>
      ARCHIVE_HEADER.every((byte, i) => archive[i] === byte),

    ingestArchive: async bytes =>
      freeAfter(new Archive(bytes), archive => keyhive.ingestArchive(archive)),
  }
}
