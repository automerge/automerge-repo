import type {
  ExtendedBackend,
  HandleExtension,
  SedimentreeEvent,
  SedimentreeId,
  SedimentreeSession,
} from "../../src/sedimentree/index.js"
import { MemoryBackend } from "../../src/sedimentree/memory/MemoryBackend.js"
import { decode, encode } from "../../src/helpers/cbor.js"
import type { DocHandle } from "../../src/DocHandle.js"
import type { PeerId, RepoId } from "../../src/types.js"

/** A hub publication: the publishing Repo and its message. */
export interface HubMessage {
  readonly originId: RepoId
  readonly message: unknown
}

/** A hub backend's session: what its `ephemeral` extension needs. */
interface HubBackendSession extends SedimentreeSession {
  publish(message: HubMessage): void
}

declare module "../../src/sedimentree/extension.js" {
  interface HandleExtensionTypes<T> {
    ephemeral: {
      members: { broadcast(message: unknown): void }
      events: {
        "ephemeral-message": (payload: {
          handle: DocHandle<T, "ephemeral">
          senderId: PeerId
          originId: RepoId
          message: unknown
        }) => void
      }
      inbound: HubMessage & { senderId: PeerId }
    }
  }
}

/** Ephemeral messaging over the hub, as a backend's handle extension. */
const ephemeral: HandleExtension<"ephemeral", HubBackendSession> = {
  kind: "ephemeral",
  extend: (base, context) =>
    class extends base {
      broadcast(message: unknown): void {
        const { session, repoId } = context(this)
        session?.publish({ originId: repoId, message })
      }
    },
  receive(context, { senderId, originId, message }) {
    if (originId === context.repoId) return
    context.emit("ephemeral-message", handle => ({
      handle,
      senderId,
      originId,
      message,
    }))
  },
}

interface HubSession {
  id: SedimentreeId
  sender: string
  inject: (event: SedimentreeEvent) => void
  closed: boolean
}

/**
 * Several Repos over one shared memory store, with ephemerals relayed between
 * their sessions on the same document. Each backend publishes as the given
 * sender, which several backends may share (e.g. tabs behind one signer). Like
 * a real backend, a session is not sent its own publications.
 */
export class EphemeralHub {
  readonly store = new MemoryBackend()
  readonly #sessions = new Set<HubSession>()
  /** Return true to drop a publication, e.g. to simulate a crashed publisher. */
  drop: (message: HubMessage, sender: string) => boolean = () => false

  backend(sender: string): ExtendedBackend<"ephemeral"> {
    const store = this.store
    const opened = new Set<SedimentreeSession>()
    return {
      handleExtensions: [ephemeral],
      create: (records, options) => store.create(records, options),
      store: (id, batch) => store.store(id, batch),
      flush: ids => store.flush(ids),
      deleteLocal: id => store.deleteLocal(id),
      open: id => {
        const session = this.#open(id, sender, () => opened.delete(session))
        opened.add(session)
        return session
      },
      // The store is shared and closed by the hub; end only this backend's watches.
      close: async () => {
        await Promise.all([...opened].map(session => session.close()))
      },
    }
  }

  close(): Promise<void> {
    return this.store.close()
  }

  #open(
    id: SedimentreeId,
    sender: string,
    onClose: () => void
  ): HubBackendSession {
    const inner = this.store.open(id)
    const queue: SedimentreeEvent[] = []
    let wake: (() => void) | undefined
    let ended = false
    const self: HubSession = {
      id,
      sender,
      closed: false,
      inject: event => {
        queue.push(event)
        wake?.()
      },
    }
    this.#sessions.add(self)
    const pump = (async () => {
      try {
        for await (const event of inner.events) self.inject(event)
      } finally {
        ended = true
        wake?.()
      }
    })()
    return {
      events: (async function* () {
        while (!ended || queue.length) {
          if (queue.length) yield queue.shift()!
          else
            await new Promise<void>(resolve => {
              wake = resolve
            })
        }
      })(),
      markReady: () => inner.markReady(),
      publish: message => {
        if (self.closed || this.drop(message, sender)) return
        for (const other of this.#sessions) {
          if (other === self || other.closed || other.id !== id) continue
          other.inject({
            type: "extension",
            kind: ephemeral.kind,
            sequence: 0,
            // Each receiver gets its own copy, as off the wire.
            payload: {
              originId: message.originId,
              senderId: sender as PeerId,
              message: decode(encode(message.message)),
            },
          })
        }
      },
      close: async () => {
        self.closed = true
        this.#sessions.delete(self)
        onClose()
        await inner.close()
        await pump
      },
    }
  }
}
