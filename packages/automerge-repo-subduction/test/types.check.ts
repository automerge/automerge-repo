// Compile-time checks of the handle types a Repo on this backend gives.
import {
  MemoryBackend,
  Repo,
  Presence,
  type DocHandle,
  type ExtendedHandle,
} from "@automerge/automerge-repo/slim"
import type {
  SedimentreeBackend,
  SedimentreeEvent,
} from "@automerge/automerge-repo/sedimentree"
import { SubductionBackend, type SubductionExtensions } from "../src/index.js"

type Todo = { title: string; items: { done: boolean }[] }
declare const backend: SubductionBackend

async function extended() {
  const repo = new Repo({ backend })
  const handle = await repo.find<Todo>("automerge:abc" as any)
  handle.broadcast("hi")
  handle.on("ephemeral-message", ({ handle: h, senderId, message }) => {
    h.broadcast(message)
    senderId satisfies string
  })
  handle.on("change", ({ doc, patches }) => {
    doc?.title satisfies string | undefined
    patches.length
  })
  // Derived handles keep the extension.
  handle.sub("items", 0).broadcast("sub")
  handle.view(handle.heads()).broadcast("view")
  handle.sub("items", 0, "done").doc() satisfies boolean | undefined
  // An extended handle is still a plain one.
  const plain: DocHandle<Todo> = handle
  void plain
  new Presence({ handle })
  const query = repo.query<Todo>("automerge:abc" as any)
  const state = query.state()
  if (state.status === "ready") state.handle.broadcast("q")
  ;(await repo.create<Todo>()).broadcast("c")
  repo.handles["x" as any].broadcast("h")
  // Core events carry the extended handle too.
  repo.on("document", ({ handle }) => handle.broadcast("d"))
  handle.on("change", ({ handle }) => handle.broadcast("c"))
  handle.sub("items").on("delete", ({ handle }) => handle.broadcast("x"))
  // @ts-expect-error not an event of this handle
  handle.on("nope", () => {})
}

async function plain() {
  const repo = new Repo()
  const handle = await repo.find<Todo>("automerge:abc" as any)
  const typed: DocHandle<Todo> = handle
  void typed
  // @ts-expect-error the memory backend has no ephemeral messaging
  handle.broadcast("hi")
  // @ts-expect-error
  handle.on("ephemeral-message", () => {})
  // @ts-expect-error
  new Presence({ handle })
}

async function untyped(backend: SedimentreeBackend) {
  const repo = new Repo({ backend })
  const handle = await repo.find<Todo>("automerge:abc" as any)
  const typed: DocHandle<Todo> = handle
  void typed
  // @ts-expect-error a backend typed loosely gives plain handles
  handle.broadcast("hi")
  // @ts-expect-error and its Repo does not pass for an extended one
  const extended: Repo<SubductionExtensions> = repo
  void extended
}

/** A backend chosen at runtime gives only what every choice provides. */
async function either(memory: boolean) {
  const repo = new Repo({ backend: memory ? new MemoryBackend() : backend })
  const handle = await repo.find<Todo>("automerge:abc" as any)
  // @ts-expect-error the memory backend has no ephemeral messaging
  handle.broadcast("hi")
}

void [extended, plain, untyped, either]

declare const base: DocHandle<Todo>
// @ts-expect-error a plain handle is not an extended one
const reverse: ExtendedHandle<Todo, SubductionExtensions> = base
// @ts-expect-error nor does it pass for one by its class
const reverseClass: DocHandle<Todo, SubductionExtensions> = base
const memoryRepo = new Repo({ backend: new MemoryBackend() })
// @ts-expect-error a plain Repo does not pass for an extended one
const reverseRepo: Repo<SubductionExtensions> = memoryRepo
// @ts-expect-error nor does annotating a plain construction
const claimed: Repo<SubductionExtensions> = new Repo()
// An extended Repo is still a plain one.
const plainRepo: Repo = new Repo({ backend })
void [reverse, reverseClass, reverseRepo, claimed, plainRepo]

// The README's way of naming the extended types.
const appRepo = new Repo({ backend })
type AppRepo = typeof appRepo
type AppHandle<T> = Awaited<ReturnType<typeof appRepo.find<T>>>
declare const appHandle: AppHandle<Todo>
appHandle.broadcast("hi")
declare function useRepo<R extends Repo = Repo>(): R
async function viaContext() {
  ;(await useRepo<AppRepo>().find<Todo>("automerge:abc" as any)).broadcast(1)
}
void viaContext

// The backend's events for the extension are typed by its kind.
function read(event: SedimentreeEvent<SubductionExtensions>) {
  if (event.type === "extension" && event.kind === "ephemeral")
    event.payload.sender.id satisfies string
}
void read
const foreign: SedimentreeEvent<SubductionExtensions> = {
  type: "extension",
  sequence: 1,
  // @ts-expect-error a kind this backend does not have
  kind: "other",
  payload: { message: null!, sender: null! },
}
void foreign

// eventNames() offers the extension's event beside the core ones.
declare const named: ExtendedHandle<Todo, SubductionExtensions>
type Names = ReturnType<typeof named.eventNames>[number]
type Listed<N> = N extends string ? (string extends N ? never : N) : never
const listed: Listed<Names>[] = ["ephemeral-message", "change"]
void listed
