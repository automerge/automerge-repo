import { next as A } from "@automerge/automerge"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DocHandle, extendHandle, instanceMembers } from "../src/DocHandle.js"
import { Repo } from "../src/Repo.js"
import {
  checkHandleExtensions,
  type HandleExtension,
  type SedimentreeEvent,
  type SedimentreeSession,
} from "../src/sedimentree/index.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"
import { scriptedBackend } from "./helpers/scriptedBackend.js"

declare module "../src/sedimentree/extension.js" {
  interface HandleExtensionTypes<T> {
    ping: {
      members: { ping(): Promise<string> }
      events: {
        pong: (payload: { handle: DocHandle<T, "ping">; n: number }) => void
      }
      inbound: number | "throw"
    }
  }
}

/** The session `ping` needs of its backend. */
interface PingSession extends SedimentreeSession {
  ping(text: string): Promise<string>
}

/** Asks its backend to answer, and reports the backend's `pong`s. */
const ping: HandleExtension<"ping", PingSession> = {
  kind: "ping",
  extend: (base, context) =>
    class extends base {
      async ping(): Promise<string> {
        const { session, repoId, documentId } = context(this)
        if (!session) throw new Error("No active session")
        return session.ping(`${repoId}/${documentId}`)
      }
    },
  receive(context, payload) {
    if (payload === "throw") throw new Error("receive failed")
    context.emit("pong", handle => ({ handle, n: payload }))
  },
}

describe("backend handle extensions", () => {
  const repos: Repo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(repo => repo.shutdown()))
    vi.restoreAllMocks()
  })

  /** A Repo on a backend that lists `ping`; its sessions answer unless told not to. */
  async function setup({ answers = true } = {}) {
    const scripted = scriptedBackend()
    const backend = Object.assign(scripted.backend, {
      handleExtensions: [ping] as const,
    })
    const repo = new Repo({ backend })
    repos.push(repo)
    const handle = await repo.import<{ count: number }>(
      A.save(A.from({ count: 0 }))
    )
    const session = await scripted.session()
    const answer = vi.fn(async (text: string) => `pong:${text}`)
    if (answers) Object.assign(session, { ping: answer })
    return { repo, handle, session, answer }
  }

  it("adds the extension's members to every handle of the Repo", async () => {
    const { repo, handle, answer } = await setup()
    const sub = handle.sub("count")
    const view = handle.view(handle.heads())
    for (const h of [handle, sub, view, await repo.find(handle.url)]) {
      expect(h).toBeInstanceOf(DocHandle)
      expect(await h.ping()).toBe(`pong:${repo.id}/${handle.documentId}`)
    }
    expect(answer).toHaveBeenCalledTimes(4)
    // A backend need not provide any: its handles are plain.
    const plain = new Repo()
    repos.push(plain)
    expect("ping" in (await plain.create())).toBe(false)
  })

  it("gives the extension the document's session while it is open", async () => {
    const { repo, handle } = await setup()
    await repo.shutdown()
    await expect(handle.ping()).rejects.toThrow("No active session")
  })

  it("fails at the call when the backend's sessions lack what the extension needs", async () => {
    const { handle } = await setup({ answers: false })
    await expect(handle.ping()).rejects.toThrow(TypeError)
  })

  it("routes the backend's extension events to its extension by kind", async () => {
    const { handle, session } = await setup()
    const sub = handle.sub("count")
    const root = vi.fn(),
      scoped = vi.fn()
    handle.on("pong", root)
    sub.on("pong", scoped)
    const event = { type: "extension", sequence: 1, kind: "ping" } as const
    // A kind nobody declared cannot be written without a cast.
    await session.push({
      ...event,
      kind: "unknown",
    } as unknown as SedimentreeEvent)
    await session.push({ ...event, payload: "throw" })
    await session.push({ ...event, payload: 2 })
    expect(root.mock.calls).toEqual([[{ handle, n: 2 }]])
    expect(scoped.mock.calls).toEqual([[{ handle: sub, n: 2 }]])
    await handle.change(doc => {
      doc.count++
    })
    expect(handle.doc()?.count).toBe(1)
  })

  describe("what an extension may add", () => {
    /** An extension whose subclass is `extend(base)`. */
    const extension = (
      kind: string,
      extend: HandleExtension["extend"]
    ): HandleExtension => ({ kind, extend })
    const defining = (kind: string, name: string) =>
      extension(kind, base => {
        const Extended = class extends base {}
        Object.defineProperty(Extended.prototype, name, { value: () => {} })
        return Extended
      })
    const withField = (kind: string) =>
      extension(
        kind,
        base =>
          class extends base {
            cache = new Map()
          }
      )

    it("Repo rejects extensions that share a kind or redefine a member", () => {
      const repo = (...handleExtensions: HandleExtension[]) =>
        new Repo({
          backend: Object.assign(new MemoryBackend(), { handleExtensions }),
        })
      expect(() => repo(ping, ping)).toThrow(/Duplicate/)
      // A method, a getter, and a member DocHandle defines per instance.
      for (const name of ["change", "url", "isReady"])
        expect(() => repo(defining("replacing", name))).toThrow(
          `replacing redefines ${name}`
        )
      expect(() => repo(ping, defining("second", "ping"))).toThrow(/redefines/)
      expect(() => repo(extension("unrelated", () => class {} as any))).toThrow(
        /subclass/
      )
    })

    it("the check for extension authors also rejects properties set on the handle", async () => {
      await expect(checkHandleExtensions([ping])).resolves.toBeUndefined()
      await expect(checkHandleExtensions([ping, ping])).rejects.toThrow(
        /Duplicate/
      )
      await expect(checkHandleExtensions([withField("field")])).rejects.toThrow(
        "field sets a property on the handle"
      )
      // Repo cannot see these, so two could silently share one name.
      const fields = [withField("first"), withField("second")]
      expect(() => extendHandle(fields)).not.toThrow()
      await expect(checkHandleExtensions(fields)).rejects.toThrow(/first sets/)
      await expect(
        checkHandleExtensions([ping, withField("after")])
      ).rejects.toThrow(/after sets/)
      // Private fields cannot clash, so they are allowed.
      const withPrivate = extension(
        "private",
        base =>
          class extends base {
            #cache = new Map()
            cached() {
              return this.#cache.size
            }
          }
      )
      await expect(
        checkHandleExtensions([withPrivate])
      ).resolves.toBeUndefined()
    })

    it("knows every member DocHandle defines per instance", async () => {
      const repo = new Repo()
      repos.push(repo)
      // A new one must be added to `instanceMembers`, or extensions could
      // redefine it unnoticed.
      expect(Reflect.ownKeys(await repo.create())).toEqual(instanceMembers)
    })
  })
})
