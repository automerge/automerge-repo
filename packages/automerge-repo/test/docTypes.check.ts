// Compile-time checks of how doc types type handles. Not a test: checked by
// `pnpm lint`.
import { Repo } from "../src/Repo.js"
import { DocHandle, isHandleOf } from "../src/types/DocHandle.js"
import { automerge } from "../src/automerge/docType.js"
import { AutomergeHandle } from "../src/automerge/handle.js"
import {
  defineDocType,
  type DocTypeContext,
  type HandleKind,
  type Shaped,
} from "../src/DocType.js"
import {
  Handle,
  type CoreHandleEvents,
  type StateChange,
} from "../src/Handle.js"
import type { AnyHandleKind, SameBackend } from "../src/types/DocHandle.js"
import { Presence } from "../src/presence/Presence.js"
import { defineExtension, provides } from "../src/sedimentree/index.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"
import type { AutomergeUrl } from "../src/automerge/url.js"
import type { DocumentId, DocumentUrl, PeerId, RepoId } from "../src/types.js"
import {
  CounterHandle,
  gcounter,
  type GCounter,
} from "./doctypes/gcounter/gcounter.js"
import { register } from "./doctypes/register/register.js"

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
declare const any: DocHandle<any, {}, AnyHandleKind>
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
  const counter = await extRepo.create(1, { docType: gcounter })
  counter.doc() satisfies number
  void counter.increment(2)
  counter.broadcast("hi")
  counter.on("change", ({ doc, handle: h }) => {
    doc satisfies number | undefined
    void h.increment(1)
    h.broadcast("changed")
  })
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
  const plain = await plainRepo.create(1, { docType: gcounter })
  // @ts-expect-error no broadcast on plain backend
  plain.broadcast("hi")
  // @ts-expect-error no ephemeral-message on plain backend
  plain.on("ephemeral-message", () => {})
  plain.on("change", ({ handle: h }) => {
    void h.increment(1)
    // @ts-expect-error no broadcast on plain backend
    h.broadcast("hi")
  })
  // @ts-expect-error plain counter is not a PresenceHandle
  new Presence({ handle: plain })

  // Doc type with no custom handle class still types doc(), change() and extensions.
  const bare = await extRepo.create(1, { docType: plainCounter })
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

// A shaped doc type whose method returns a handle for part of the document
// keeps the backend's members on it, with `SameBackend`.
class TreeHandle<T> extends Handle<T, T> {
  at<K extends keyof T>(key: K): SameBackend<this, TreeHandle<T[K]>> {
    return key as never
  }
}
interface Tree extends Shaped {
  readonly scheme: "tree"
  readonly handle: TreeHandle<this["Shape"]>
}
const tree = defineDocType({
  scheme: "tree",
  create: (init: unknown) => ({ init }),
  value: s => s.init,
  change: (s, init: unknown) => ({ init }),
  apply: () => ({ init: undefined as unknown }),
  heads: () => [],
  hasHeads: () => false,
  recordsSince: () => [],
  handle: TreeHandle,
}).as<Tree>()
type Nested = { a: { b: { c: number } } }
export async function sameBackend() {
  const extRepo = new Repo({ backend: new EphemeralBackend() })
  const t = await extRepo.find("tree:x" as DocumentUrl<"tree">, {
    docType: tree.of<Nested>(),
  })
  t.at("a").at("b").doc().c satisfies number
  t.at("a").at("b").broadcast("deep")
  t.at("a").on("ephemeral-message", ({ handle }) => handle.at("b").broadcast(1))
  new Presence({ handle: t.at("a") })
  // @ts-expect-error not a key
  t.at("nope")
  const plainT = await new Repo().find("tree:x" as DocumentUrl<"tree">, {
    docType: tree.of<Nested>(),
  })
  // @ts-expect-error a plain backend's derived handles have no broadcast
  plainT.at("a").broadcast("hi")
}

// Every handle is exactly a `DocHandle<…>`: the types Repo gives are
// identical to the ones apps would write.
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
type Todo2 = { title: string; items: { done: boolean }[] }
export async function exactly() {
  const plainRepo = new Repo()
  const extRepo = new Repo({ backend: new EphemeralBackend() })
  const doc = await plainRepo.find<Todo2>("x" as AutomergeUrl)
  const docExt = await extRepo.find<Todo2>("x" as AutomergeUrl)
  const counter = await extRepo.create(1, { docType: gcounter })
  const checks: [
    Equal<typeof doc, DocHandle<Todo2>>,
    Equal<ReturnType<typeof doc.sub<["title"]>>, DocHandle<string>>,
    Equal<typeof docExt, DocHandle<Todo2, EphemeralLikeSpec>>,
    Equal<
      ReturnType<typeof docExt.sub<["items", 0]>>,
      DocHandle<{ done: boolean }, EphemeralLikeSpec>
    >,
    Equal<typeof counter, DocHandle<unknown, EphemeralLikeSpec, GCounter>>,
  ] = [true, true, true, true, true]
  return checks
}

// Automerge takes a shape the way other shaped types do.
export async function automergeOf() {
  const r = new Repo({ backend: new EphemeralBackend() })
  const viaOf = await r.find("automerge:x" as AutomergeUrl, {
    docType: automerge.of<Todo2>(),
  })
  const same: Equal<typeof viaOf, DocHandle<Todo2, EphemeralLikeSpec>> = true
  viaOf.sub("items", 0).broadcast("sub")
  return same
}

// Mistakes the compiler catches.
const storage = {
  apply: () => ({ v: 0 as unknown }),
  heads: () => [],
  hasHeads: () => false,
  recordsSince: () => [],
}
class OtherHandle<T> extends Handle<T, T> {
  other(): T {
    return this.doc()
  }
}
interface WrongClass extends Shaped {
  readonly scheme: "wrong-class"
  readonly handle: OtherHandle<this["Shape"]>
}
defineDocType({
  scheme: "wrong-class",
  create: (v: unknown) => ({ v }),
  value: (s: { v: unknown }) => s.v,
  change: (_s: { v: unknown }, v: unknown) => ({ v }),
  ...storage,
  handle: TreeHandle,
  // @ts-expect-error the kind names a different class from `handle`
}).as<WrongClass>()
// @ts-expect-error a counter takes no shape
gcounter.of<Todo2>()
class StringHandle extends Handle<string, string> {}
defineDocType({
  scheme: "mismatch",
  create: (n: number) => ({ v: n as unknown }),
  value: (s: { v: unknown }) => s.v as number,
  change: (_s: { v: unknown }, by: number) => ({ v: by as unknown }),
  ...storage,
  // @ts-expect-error the class's doc() and change() types disagree with the type
  handle: StringHandle,
})

// A class whose doc() may be undefined and whose change() accepts wider inputs
// is accepted, while the type's own `value` and `change` keep their types.
class MaybeNumberHandle extends Handle<number | undefined, number | string> {}
const maybeNumber = defineDocType({
  scheme: "maybe-number",
  create: (n: number) => ({ v: n as unknown }),
  value: (s: { v: unknown }) => s.v as number,
  change: (_s: { v: unknown }, by: number) => ({ v: by as unknown }),
  ...storage,
  handle: MaybeNumberHandle,
})
declare const numberState: { v: unknown }
declare const context: DocTypeContext
maybeNumber.value(numberState) satisfies number
// @ts-expect-error change takes a number
maybeNumber.change(numberState, "1", context)

// Automerge's own `value` and `change` keep Automerge's types.
declare const automergeDoc: ReturnType<typeof automerge.create>
const automergeValueIsDefined: undefined extends ReturnType<
  typeof automerge.value
>
  ? false
  : true = true
void automergeValueIsDefined
// @ts-expect-error change takes a change function
automerge.change(automergeDoc, 5, context)
automerge.handle satisfies typeof AutomergeHandle
interface WrongScheme extends HandleKind {
  readonly scheme: "not-gcounter"
  readonly handle: CounterHandle
}
defineDocType({
  ...gcounter,
  scheme: "gcounter-copy",
  handle: CounterHandle,
  // @ts-expect-error the kind's scheme differs from the definition's
}).as<WrongScheme>()

// Handles' URLs use their doc type's scheme.
export async function urls() {
  const r = new Repo({ backend: new EphemeralBackend() })
  const counter = await r.create(1, { docType: gcounter })
  const doc = await r.find<Todo2>("automerge:x" as AutomergeUrl)
  const bare = await r.create(1, { docType: plainCounter })
  const listed = r.handles["x" as DocumentId]
  const checks: [
    Equal<typeof counter.url, DocumentUrl<"gcounter">>,
    Equal<typeof doc.url, AutomergeUrl>,
    Equal<typeof bare.url, DocumentUrl<"plain-counter">>,
  ] = [true, true, true]
  const fromView: DocumentUrl<"gcounter"> = counter.view(counter.heads()).url
  const fromSub: AutomergeUrl = doc.sub("items", 0).url
  const any: DocumentUrl = counter.url
  const fromListed: DocumentUrl = listed.url
  // @ts-expect-error a counter's URL is not an Automerge document's
  const wrong: AutomergeUrl = counter.url
  return [checks, fromView, fromSub, any, fromListed, wrong]
}

// `find`, `query` and `findWithProgress` check a typed URL's doc type.
export async function findChecks() {
  const r = new Repo()
  const counter = await r.create(1, { docType: gcounter })
  const doc = await r.find<Todo2>("automerge:x" as AutomergeUrl)
  const link = "automerge:x" as DocumentUrl
  await r.find(counter.url, { docType: gcounter })
  await r.find(doc.url)
  await r.find<Todo2>(doc.sub("items", 0).url)
  await r.find(counter.documentId, { docType: gcounter })
  // Plain links, e.g. read from a document, open as any doc type.
  await r.find(link)
  await r.find(link, { docType: gcounter })
  // @ts-expect-error a counter's URL needs its doc type
  await r.find(counter.url)
  // @ts-expect-error even with a shape
  await r.find<Todo2>(counter.url)
  // @ts-expect-error a counter's URL is not a register's
  await r.find(counter.url, { docType: register.of<Todo2>() })
  // @ts-expect-error an Automerge document's URL is not a counter's
  r.query(doc.url, { docType: gcounter })
  // @ts-expect-error nor through findWithProgress
  r.findWithProgress(counter.url)
}

// `changeEventPayload` is checked against the handle's `change` event type.
type DeltaEvents = Omit<CoreHandleEvents<number>, "change"> & {
  change: (payload: { handle: DeltaHandle; doc: number; delta: number }) => void
}
class DeltaHandle extends Handle<number, number, DeltaEvents> {
  protected changeEventPayload(_change: StateChange) {
    return { handle: this, doc: this.doc(), delta: 1 }
  }
}
class BadDeltaHandle extends Handle<number, number, DeltaEvents> {
  // @ts-expect-error missing `delta` required by `DeltaEvents["change"]`
  protected changeEventPayload(_change: StateChange) {
    return { handle: this, doc: this.doc() }
  }
}
void [DeltaHandle, BadDeltaHandle]
