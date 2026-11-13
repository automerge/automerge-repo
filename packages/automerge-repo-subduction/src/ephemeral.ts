import { Encoder, decode } from "cbor-x"
import {
  BackendError,
  defineExtension,
  type BackendIdentity,
  type SedimentreeEvent,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree"
import type {
  ExtendedHandle,
  PeerId,
  RepoId,
  PresenceHandle,
  PresenceInbound,
} from "@automerge/automerge-repo/slim"

/** An ephemeral message on the wire. */
export interface EphemeralEnvelope {
  readonly messageId: string
  /** The Repo it was published for; claimed, not verified. */
  readonly origin: BackendIdentity
  readonly payload: Uint8Array
}

/** What the backend's `ephemeral` session events carry. */
export interface EphemeralInbound {
  readonly message: EphemeralEnvelope
  /** Verified sender. */
  readonly sender: BackendIdentity
}

/** A session event carrying a message to the `ephemeral` extension. */
export interface EphemeralEvent {
  readonly type: "extension"
  readonly sequence: number
  readonly kind: "ephemeral"
  readonly payload: EphemeralInbound
}

/** An event of a Subduction session. */
export type SubductionEvent = SedimentreeEvent | EphemeralEvent

/** A session of the Subduction backend. */
export interface SubductionSession extends SedimentreeSession {
  readonly events: AsyncIterable<SubductionEvent>
  /** Publish to the peers subscribed to this session's document. The
   * `ephemeral` handle extension sends through this. */
  publishEphemeral(message: EphemeralEnvelope): Promise<void>
}

/**
 * Emitted when an ephemeral message is received for the document. `senderId`
 * is the peer Subduction authenticated; `originId` is the sending Repo's `id`.
 */
export interface EphemeralMessagePayload<T> extends PresenceInbound {
  handle: ExtendedHandle<T, SubductionExtensions>
}

/** What the `ephemeral` extension adds to a handle. */
export interface EphemeralMembers {
  /**
   * Sends an arbitrary ephemeral message out to all reachable peers who would receive sync messages
   * from you. It has no guarantee of delivery, and is not persisted to the underlying automerge doc
   * in any way. It is sent from this Repo's peer on behalf of this Repo: receivers see the peer
   * Subduction authenticated as `senderId`, which several Repos (e.g. tabs sharing one signer)
   * may share, and this Repo's `id` as `originId`, which tells those Repos apart. Neither is a
   * user identifier. Messages are scoped to the whole document: a sub-handle's broadcasts reach
   * the root and every other handle of it.
   */
  broadcast(message: unknown): void
}

/** The events the `ephemeral` extension emits on handles. */
export interface EphemeralEvents {
  /** Emitted with the handle as {@link EphemeralMessagePayload}. */
  "ephemeral-message": PresenceInbound
}

/** What the Subduction backend's extensions add to the handles of a Repo on
 * it; name such a Repo as `Repo<SubductionExtensions>`. */
export interface SubductionExtensions {
  members: EphemeralMembers
  events: EphemeralEvents
}

// Fails to compile if handles with this extension stop fitting Presence.
type Fits<Contract, _Handle extends Contract> = Contract
type _FitsPresence = Fits<
  PresenceHandle,
  ExtendedHandle<unknown, SubductionExtensions>
>

// Untagged byte strings keep the encoding identical with and without Node's Buffer.
const codec = new Encoder({ useRecords: false, tagUint8Array: false })
export const maxEphemeralBytes = 65536

function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}
function isEnvelope(value: unknown): value is EphemeralEnvelope {
  const message = value as EphemeralEnvelope | undefined
  return (
    !!message &&
    text(message.messageId) &&
    !!message.origin &&
    text(message.origin.kind) &&
    text(message.origin.id) &&
    Array.isArray(message.origin.path) &&
    message.origin.path.length <= 16 &&
    [...message.origin.path].every(text) &&
    message.payload instanceof Uint8Array
  )
}
function invalid(message: string): BackendError {
  return new BackendError("extension", "invalid-record", message)
}
export function encodeEphemeral(message: EphemeralEnvelope): Uint8Array {
  if (!isEnvelope(message)) throw invalid("Invalid ephemeral envelope")
  const { messageId, origin, payload } = message
  const { kind, id, path } = origin
  const bytes = codec.encode([1, messageId, { kind, id, path }, payload])
  if (bytes.byteLength > maxEphemeralBytes)
    throw invalid("Encoded ephemeral exceeds 65536 bytes")
  // A plain view: cbor-x returns a Buffer under Node.
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}
/** Decoded metadata is frozen; the payload is a view of `bytes`. */
export function decodeEphemeral(
  bytes: Uint8Array
): EphemeralEnvelope | undefined {
  if (bytes.byteLength > maxEphemeralBytes) return
  try {
    const tuple: unknown = codec.decode(bytes)
    if (!Array.isArray(tuple) || tuple.length !== 4 || tuple[0] !== 1) return
    const [, messageId, origin, payload] = tuple
    const message = { messageId, origin, payload }
    if (!isEnvelope(message)) return
    const { kind, id, path } = message.origin
    return Object.freeze({
      messageId,
      origin: Object.freeze({ kind, id, path: Object.freeze(path) }),
      payload,
    })
  } catch {
    return
  }
}

/**
 * Ephemeral messaging on every handle: `broadcast()` and the
 * `ephemeral-message` event, carried by Subduction's ephemeral topics.
 */
export const ephemeral = defineExtension<
  SubductionSession,
  SubductionExtensions,
  EphemeralInbound
>({
  kind: "ephemeral",
  members: {
    broadcast(document, message: unknown): void {
      // Encoded now, so later changes to `message` are not sent.
      const bytes = codec.encode(message)
      const payload = new Uint8Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      )
      const envelope: EphemeralEnvelope = {
        messageId: crypto.randomUUID(),
        origin: { kind: "repo", id: document.repoId, path: [] },
        payload,
      }
      // Best effort: failures are logged, never thrown.
      void (async () => {
        const session = document.requireSession()
        await session.publishEphemeral(envelope)
      })().catch(error =>
        document.log("ephemeral publication failed: %o", error)
      )
    },
  },
  receive(document, { message, sender }) {
    // Subduction also delivers a peer's own publications back to it.
    if (message.origin.id === document.repoId) return
    let decoded: unknown
    try {
      decoded = decode(message.payload)
    } catch (error) {
      document.log("invalid ephemeral message: %o", error)
      return
    }
    document.emit("ephemeral-message", {
      senderId: sender.id as PeerId,
      originId: message.origin.id as RepoId,
      message: decoded,
    })
  },
})
