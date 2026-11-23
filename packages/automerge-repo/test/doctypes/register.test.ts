import { afterEach, describe, expect, it } from "vitest"
import { Repo } from "../../src/Repo.js"
import { DocHandle, isHandleOf } from "../../src/types/DocHandle.js"
import { Presence } from "../../src/presence/Presence.js"
import { defineExtension, provides } from "../../src/sedimentree/index.js"
import { MemoryBackend } from "../../src/sedimentree/memory/MemoryBackend.js"
import type { PeerId, RepoId } from "../../src/types.js"
import { register, RegisterHandle, type Register } from "./register.js"

type Todo = { title: string; done: boolean }

/** Members and events like Subduction's ephemeral messaging. */
interface EphemeralLike {
  members: { broadcast(message: unknown): void }
  events: {
    "ephemeral-message": {
      senderId: PeerId
      originId: RepoId
      message: unknown
    }
  }
}
const ephemeralLike = defineExtension<EphemeralLike>({
  members: { broadcast: () => {} },
})
class EphemeralBackend extends MemoryBackend {
  readonly handleExtensions = provides(ephemeralLike)
}

describe("a register: a doc type generic in its document's shape", () => {
  const repos: Repo<any>[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map(r => r.shutdown()))
  })
  const repo = (backend = new MemoryBackend()) => {
    const r = new Repo({ backend })
    repos.push(r)
    return r
  }

  it("reads and changes a document of the shape it was given", async () => {
    const todo = await repo().create(
      { title: "a", done: false },
      { type: register.of<Todo>() }
    )
    expect(todo).toBeInstanceOf(DocHandle)
    expect(todo).toBeInstanceOf(RegisterHandle)
    expect(todo.get("title")).toBe("a")
    await todo.set("done", true)
    expect(todo.doc()).toEqual({ title: "a", done: true })
  })

  it("finds it from another Repo, by the same doc type for any shape", async () => {
    const backend = new MemoryBackend()
    const todo = await repo(backend).create(
      { title: "a", done: false },
      { type: register.of<Todo>() }
    )
    const found = await repo(backend).find(todo.url, {
      type: register.of<Todo>(),
    })
    expect(found.get("title")).toBe("a")
    // `of` is type-level: every shape is the same doc type object.
    expect(register.of<Todo>()).toBe(register)
  })
})

// Types, checked by `pnpm lint`.
export async function types() {
  const plain = new Repo()
  const ext = new Repo({ backend: new EphemeralBackend() })

  const todo = await ext.create(
    { title: "a", done: false },
    { type: register.of<Todo>() }
  )
  const named: DocHandle<Todo, EphemeralLike, Register> = todo
  todo.doc().title satisfies string
  todo.get("done") satisfies boolean
  void todo.set("done", true)
  // @ts-expect-error not a field of Todo
  todo.get("nope")
  // @ts-expect-error the wrong type for `done`
  void todo.set("done", "yes")
  // @ts-expect-error `create` takes a Todo for this shape
  await ext.create({ other: 1 }, { type: register.of<Todo>() })

  // The backend's members and events, on the handle and its views.
  todo.broadcast("hi")
  todo.on("ephemeral-message", ({ senderId, handle }) => {
    senderId satisfies PeerId
    handle.get("title") satisfies string
  })
  todo.on("change", ({ doc }) => doc?.title satisfies string | undefined)
  const view = todo.view(todo.heads())
  view.get("title") satisfies string
  view.broadcast("from a view")
  new Presence({ handle: view })

  const found = await ext.find(todo.url, { type: register.of<Todo>() })
  found.get("done") satisfies boolean
  const listed = ext.handles[todo.documentId]
  if (isHandleOf(listed, register)) listed.broadcast("listed")

  // A plain backend has none of the backend's members.
  const p = await plain.find(todo.url, { type: register.of<Todo>() })
  p.get("title") satisfies string
  // @ts-expect-error a plain backend has no broadcast
  p.broadcast("hi")
  // @ts-expect-error a plain handle is not an extended one
  const up: DocHandle<Todo, EphemeralLike, Register> = p
  // @ts-expect-error another shape
  const wrong: DocHandle<{ other: number }, {}, Register> = p
  // @ts-expect-error a register handle is not an Automerge handle
  const cross: DocHandle<Todo> = p
  return [named, up, wrong, cross]
}

// Code generic over the shape and the backend.
export function generic<T extends { title: string }, X extends EphemeralLike>(
  h: DocHandle<T, X, Register>,
  r: Repo<X>
) {
  h.get("title") satisfies T["title"]
  h.broadcast("hi")
  new Presence({ handle: h })
  const back: Promise<DocHandle<T, X, Register>> = r.find(h.url, {
    type: register.of<T>(),
  })
  return back
}
