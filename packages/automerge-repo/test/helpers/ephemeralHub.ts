import type {
  EphemeralEnvelope,
  SedimentreeBackend,
  SedimentreeEvent,
  SedimentreeId,
  SedimentreeSession,
} from "../../src/sedimentree/index.js"
import { MemoryBackend } from "./MemoryBackend.js"

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
  drop: (message: EphemeralEnvelope, sender: string) => boolean = () => false

  backend(sender: string): SedimentreeBackend {
    const store = this.store
    const opened = new Set<SedimentreeSession>()
    return {
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
  ): SedimentreeSession {
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
      synchronize: options => inner.synchronize(options),
      markComplete: () => inner.markComplete?.(),
      publishEphemeral: async message => {
        if (self.closed || this.drop(message, sender)) return
        for (const other of this.#sessions) {
          if (other === self || other.closed || other.id !== id) continue
          other.inject({
            type: "ephemeral",
            sequence: 0,
            message: { ...message, payload: new Uint8Array(message.payload) },
            sender: { kind: "test", id: sender, path: [] },
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
