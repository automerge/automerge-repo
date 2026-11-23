// Compile-time checks of how doc types type handles. Not a test: checked by
// `pnpm lint`.
import { Repo } from "../src/Repo.js"
import { DocHandle, isHandleOf } from "../src/types/DocHandle.js"
import { automerge } from "../src/automerge/docType.js"
import { defineDocType, type AnyDocType } from "../src/DocType.js"
import { Presence } from "../src/presence/Presence.js"
import { defineExtension, provides } from "../src/sedimentree/index.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"
import type { AutomergeUrl, PeerId, RepoId } from "../src/types.js"
import { gcounter } from "./doctypes/gcounter.js"

type Doc = { title: string; items: string[] }

// The default doc type is Automerge: `DocHandle<T>` keeps its whole API.
declare const handle: DocHandle<Doc>
handle.doc()?.title satisfies string | undefined
handle.sub("items", 0).doc() satisfies string | undefined
void handle.change(d => {
  d.title = "x"
})
handle.fullDoc() satisfies { title: string }

// In generic code too: the doc type parameter is concrete, so nothing is
// left unresolved (a conditional on `T` would make `h` a union here).
export function generic<T extends { items: string[] }>(h: DocHandle<T>) {
  h.sub("items").doc()
  h.diff(h.heads())
  h.on("change", ({ patches }) => patches.length)
  const fromRepo: Promise<DocHandle<T>> = new Repo().find<T>("" as AutomergeUrl)
  return fromRepo
}

// A handle of any type has the core API, loosely typed, and no Automerge
// members until narrowed.
declare const any: DocHandle<any, {}, AnyDocType>
any.doc() satisfies any
void any.change(5)
// @ts-expect-error not every type has sub-handles
any.sub("items")
if (isHandleOf(any, automerge))
  any.sub("items")

  // Every handle is a DocHandle at runtime.
;(handle instanceof DocHandle) satisfies boolean

// A doc type with no custom handle class still derives doc(), change() and
// change-event types from its definition.
const plainCounter = defineDocType({
  scheme: "plain-counter",
  create: (n: number) => ({ n }),
  value: s => s.n,
  change: (s, by: number) => ({ n: s.n + by }),
  apply: () => ({ n: 0 }),
  heads: () => [],
  hasHeads: () => false,
  recordsSince: () => [],
})

// Backend extension with members and events (same shape as Subduction's ephemeral).
interface EphemeralLikeSpec {
  members: { broadcast(message: unknown): void }
  events: {
    "ephemeral-message": {
      senderId: PeerId
      originId: RepoId
      message: unknown
    }
  }
}
const ephemeralLike = defineExtension<EphemeralLikeSpec>({
  members: { broadcast: () => {} },
})
class EphemeralBackend extends MemoryBackend {
  readonly handleExtensions = provides(ephemeralLike)
}

export async function extensionTyping() {
  const extRepo = new Repo({ backend: new EphemeralBackend() })
  const plainRepo = new Repo()

  // Counter with custom handle class on an extended backend: members, events,
  // Presence, and pinned views all type-check without casts.
  const counter = await extRepo.create(1, { type: gcounter })
  counter.doc() satisfies number
  void counter.increment(2)
  counter.broadcast("hi")
  counter.on("change", ({ doc }) => doc satisfies number | undefined)
  counter.on("ephemeral-message", ({ senderId, message, handle: h }) => {
    senderId satisfies PeerId
    message satisfies unknown
    h.increment(1)
    h.broadcast("reply")
  })
  new Presence({ handle: counter })

  const view = counter.view(counter.heads())
  view.doc() satisfies number
  view.broadcast("hi")
  view.on("ephemeral-message", ({ originId }) => originId satisfies RepoId)
  new Presence({ handle: view })

  // Narrowing a repo.handles entry preserves backend extensions & events.
  const listed = extRepo.handles[counter.documentId]
  if (isHandleOf(listed, gcounter)) {
    listed.doc() satisfies number
    void listed.increment(1)
    listed.broadcast("hi")
    listed.on("ephemeral-message", ({ senderId }) => senderId satisfies PeerId)
    new Presence({ handle: listed })
  }

  // Plain backend counter rejects extension members, events and Presence.
  const plain = await plainRepo.create(1, { type: gcounter })
  // @ts-expect-error no broadcast on plain backend
  plain.broadcast("hi")
  // @ts-expect-error no ephemeral-message on plain backend
  plain.on("ephemeral-message", () => {})
  // @ts-expect-error plain counter is not a PresenceHandle
  new Presence({ handle: plain })

  // Doc type with no custom handle class still types doc(), change() and extensions.
  const bare = await extRepo.create(1, { type: plainCounter })
  bare.doc() satisfies number
  void bare.change(2)
  // @ts-expect-error change takes a number
  void bare.change("x")
  bare.on("change", ({ doc }) => doc satisfies number | undefined)
  bare.broadcast("hi")
  bare.on("ephemeral-message", ({ senderId }) => senderId satisfies PeerId)
  new Presence({ handle: bare })
}

// Backend extensions cannot call Automerge-only members on an arbitrary handle.
defineExtension<{ members: { bad(): unknown } }>({
  members: {
    // @ts-expect-error backend extensions may only use core handle members
    bad: (_context, h) => h.sub("x"),
  },
})
