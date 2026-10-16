import { vi, type Mock } from "vitest"
import { MemoryBackend } from "../../src/sedimentree/testing/MemoryBackend.js"
import type {
  SedimentreeEvent,
  SedimentreeId,
  SedimentreeSession,
  SyncRoundResult,
} from "../../src/sedimentree/index.js"

/** A session whose events the test pushes by hand. */
export interface ScriptedSession {
  readonly id: SedimentreeId
  readonly synchronize: Mock<SedimentreeSession["synchronize"]>
  readonly publishEphemeral: Mock<SedimentreeSession["publishEphemeral"]>
  readonly markComplete: Mock<() => void>
  readonly close: Mock<SedimentreeSession["close"]>
  readonly closed: boolean
  /** Deliver one event and wait until the consumer has processed it. */
  push(event: SedimentreeEvent): Promise<void>
  /** End the stream, optionally after a final event the consumer processes first. */
  end(event?: SedimentreeEvent): Promise<void>
}

export const noPeers = (): SyncRoundResult => ({
  roundId: "scripted",
  marker: { sequence: 0, heads: [] },
  outcome: "no-peers",
  peers: [],
})

/**
 * Backend whose `open()` returns scripted sessions. Everything else is a real
 * MemoryBackend, so stores, flush and deletion behave normally.
 */
export function scriptedBackend() {
  const backend = new MemoryBackend()
  const sessions: ScriptedSession[] = []
  const waiting: ((session: ScriptedSession) => void)[] = []
  const close = backend.close.bind(backend)
  vi.spyOn(backend, "close").mockImplementation(async () => {
    await Promise.all(sessions.map(session => session.close()))
    await close()
  })
  vi.spyOn(backend, "open").mockImplementation(id => {
    const queue: { event?: SedimentreeEvent; done: () => void }[] = []
    let wake: (() => void) | undefined
    let ended = false
    let closed = false
    const events: AsyncIterable<SedimentreeEvent> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift()
          if (next) {
            if (next.event) {
              try {
                yield next.event
              } finally {
                next.done()
              }
              continue
            }
            next.done()
            return
          }
          if (ended || closed) return
          await new Promise<void>(resolve => {
            wake = resolve
          })
          wake = undefined
        }
      },
    }
    const enqueue = (event?: SedimentreeEvent) =>
      new Promise<void>(done => {
        queue.push({ event, done })
        wake?.()
      })
    const session: ScriptedSession & SedimentreeSession = {
      id,
      events,
      get closed() {
        return closed
      },
      synchronize: vi.fn(async () => noPeers()),
      publishEphemeral: vi.fn(async () => {}),
      markComplete: vi.fn(),
      close: vi.fn(async () => {
        closed = true
        wake?.()
      }),
      push: event => enqueue(event),
      /** Resolves once the final event (if any) is processed; the stream then ends. */
      end: async event => {
        if (event) await enqueue(event)
        ended = true
        wake?.()
      },
    }
    sessions.push(session)
    waiting.splice(0).forEach(resolve => resolve(session))
    return session
  })
  return {
    backend,
    sessions,
    /** The next session opened (or the latest one already open). */
    session(index = sessions.length - 1): Promise<ScriptedSession> {
      if (sessions[index]) return Promise.resolve(sessions[index])
      return new Promise(resolve => waiting.push(resolve))
    },
  }
}
