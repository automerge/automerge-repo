// Compile-time checks of how handle extensions type Repos and handles.
// Not a test: checked by `pnpm lint`.
import { EventEmitter } from "eventemitter3"
import { Repo } from "../src/Repo.js"
import { DocHandle } from "../src/types/DocHandle.js"
import type { HandleOf } from "../src/Repo.js"
import type { DocHandleChangePayload } from "../src/DocHandleEvents.js"
import type { DocumentQuery, QueryState } from "../src/DocumentQuery.js"
import type { UrlHeads } from "../src/types.js"
import type { AnyDocType } from "../src/DocType.js"
import type {
  AnyHandleExtension,
  EventFor,
  ExtensionEvent,
  ExtensionsOf,
  HandleExtension,
  SessionFor,
  SedimentreeBackend,
  SedimentreeEvent,
  SedimentreeId,
  SedimentreeSession,
} from "../src/sedimentree/index.js"
import { defineExtension } from "../src/sedimentree/defineExtension.js"
import { provides } from "../src/sedimentree/provides.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"

type Doc = { title: string }
interface ASpec {
  members: { a(): string }
  events: { "a-event": { n: number } }
}
interface BSpec {
  members: { b(): void }
  events: { "b-event": { s: string } }
}
/** The session extension `a` needs of its backend. */
interface SessionA extends SedimentreeSession {
  ping(text: string): Promise<number>
}
/** Extension `a`'s spec in full: also its session and what its backend
 * sends it. */
interface ASpecFull extends ASpec {
  session: SessionA
  receives: { a: { n: number } }
}
declare const extA: HandleExtension<ASpecFull>
declare const extB: HandleExtension<BSpec>
class BackendA extends MemoryBackend {
  readonly handleExtensions = provides(extA)
}
/** Several extensions give the intersection of their specs. */
class BackendAB extends MemoryBackend {
  readonly handleExtensions = provides(extA, extB)
}
declare const loose: SedimentreeBackend
const url = "automerge:x" as any

const plainRepo = new Repo()
const repoA = new Repo({ backend: new BackendA() })
const repoAB = new Repo({ backend: new BackendAB() })
const repoLoose = new Repo({ backend: loose })
declare const hPlain: DocHandle<Doc>
declare const hA: DocHandle<Doc, ASpec>
declare const hAB: DocHandle<Doc, ASpec & BSpec>

// Extended things are accepted where plain ones, or ones with fewer
// extensions, are wanted.
const ok: [
  Repo,
  Repo,
  Repo<ASpec>,
  Repo,
  Repo<ASpec>[],
  DocHandle<Doc>,
  DocHandle<unknown>,
  DocHandle<Doc, ASpec>,
  DocHandle<Doc, ASpec>,
  DocHandle<Doc>[],
  DocumentQuery<Doc>,
  DocumentQuery<Doc, ASpec>,
  QueryState<Doc>,
  EventEmitter,
] = [
  repoA,
  repoAB,
  repoAB,
  repoLoose,
  [repoA, repoAB],
  hA,
  hA,
  hAB,
  hAB,
  [hA, hAB, hPlain],
  repoA.query<Doc>(url),
  repoAB.query<Doc>(url),
  repoAB.query<Doc>(url).state(),
  repoA,
]

// The reverse is not.
// @ts-expect-error
const bad1: Repo<ASpec> = plainRepo
// @ts-expect-error
const bad2: Repo<ASpec & BSpec> = repoA
// @ts-expect-error
const bad3: DocHandle<Doc, ASpec> = hPlain
// @ts-expect-error
const bad4: DocHandle<Doc, ASpec & BSpec> = hA
// @ts-expect-error
const bad5: DocumentQuery<Doc, ASpec> = plainRepo.query<Doc>(url)
// @ts-expect-error a backend typed loosely gives a plain Repo
const bad6: Repo<ASpec> = repoLoose
// Known gap: annotating a construction asserts the spec. The annotation is
// the visible false claim; a Repo built elsewhere does not pass (bad1).
const gap1: Repo<ASpec> = new Repo()
const gap2: Repo<ASpec> = new Repo({ backend: new MemoryBackend() })
// A backend chosen at runtime, where one choice extends the other's class,
// gives what every choice provides: here nothing…
const repoEither = new Repo({
  backend: Math.random() > 0.5 ? new BackendA() : new MemoryBackend(),
})
// @ts-expect-error
const bad9: Repo<ASpec> = repoEither
// …and here extension `a`, which both declare.
const repoBoth = new Repo({
  backend: Math.random() > 0.5 ? new BackendA() : new BackendAB(),
})
const okBoth: Repo<ASpec> = repoBoth
async function common() {
  const handle = await repoBoth.find<Doc>(url)
  handle.a()
  // @ts-expect-error only one choice has `b`
  handle.b()
}

// Members and events follow the document type, sub-handles and views.
async function members() {
  const handle = await repoAB.find<Doc>(url)
  handle.a().toUpperCase()
  handle.sub("title").a()
  handle.view(handle.heads()).b()
  // Extension event payloads carry the extended handle.
  handle.on("a-event", ({ n, handle }) => handle.a() + n.toFixed())
  // Each listed extension's events are there.
  handle.on("b-event", ({ s, handle }) => handle.b() ?? s.toUpperCase())
  handle.on("change", () => {}).b()
  // @ts-expect-error repoA does not list b's extension
  ;(await repoA.find<Doc>(url)).on("b-event", () => {})
  // @ts-expect-error
  ;(await plainRepo.find<Doc>(url)).a()
  // @ts-expect-error
  ;(await repoLoose.find<Doc>(url)).a()
}

// eventNames() offers the handle's own event names, sub-handles included,
// without stopping any other string.
type Named<N> = N extends string ? (string extends N ? never : N) : never
type NamesOf<H extends { eventNames(): unknown[] }> = Named<
  ReturnType<H["eventNames"]>[number]
>
const extendedName: NamesOf<typeof hA> = "a-event"
const coreName: NamesOf<typeof hPlain> = "change"
// @ts-expect-error a plain handle has no such event
const noSuchName: NamesOf<typeof hPlain> = "a-event"
const subName: NamesOf<ReturnType<typeof hA.sub<["title"]>>> = "a-event"
const anyName: ReturnType<typeof hPlain.eventNames>[number] = "anything"
void [extendedName, coreName, noSuchName, subName, anyName]

type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
// HandleOf names a Repo's handle type.
const ofRepo: Equal<HandleOf<typeof repoA, Doc>, DocHandle<Doc, ASpec>> = true
void ofRepo

// Repo-level event payloads carry the extended handle; handle-level
// payloads carry a plain one (use the handle the listener attached to).
repoA.on("document", ({ handle }) => handle.a())
// @ts-expect-error
plainRepo.on("document", ({ handle }) => handle.a())
hA.on("change", ({ handle }) => {
  // @ts-expect-error core payload handles are plain; hA itself has `a`
  handle.a()
  hA.a()
})
// Listeners written against plain handles attach everywhere.
const plainListener = ({ handle }: { handle: DocHandle<any> }) => handle.url
hA.on("delete", plainListener)
// A Repo's documents may be of any doc type, so its `document` listeners take
// any handle; one written against Automerge handles no longer attaches.
// @ts-expect-error `document` handles are not assumed to be Automerge
repoA.on("document", plainListener)
repoA.on(
  "document",
  ({ handle }: { handle: DocHandle<any, {}, AnyDocType> }) => handle.url
)
hA.on("change", (payload: DocHandleChangePayload<Doc>) => payload.patches)

void [ok, bad1, bad2, bad3, bad4, bad5, bad6, gap1, gap2, bad9, okBoth]

// A backend that declares its sessions as what its extension needs has that
// checked where it opens them.
class Serving extends MemoryBackend {
  readonly handleExtensions = provides(extA)
  override open(id: SedimentreeId): SessionA {
    return Object.assign(super.open(id), { ping: async () => 1 })
  }
}
class NotServing extends MemoryBackend {
  readonly handleExtensions = provides(extA)
  override open(id: SedimentreeId): SessionA {
    // @ts-expect-error its sessions lack `ping`
    return super.open(id)
  }
}

// defineExtension: the context is typed, members are checked against the
// spec, and the declared events are the only ones it can emit.
const defined = defineExtension<ASpecFull>({
  members: {
    a(context, handle) {
      const session = context.requireSession()
      void session.ping("x")
      // The calling handle has the spec's members.
      return handle.a() + handle.url
    },
  },
  receive: {
    a(context, payload) {
      payload.n.toFixed()
      void context.session?.ping("x")
      context.emit("a-event", { n: payload.n })
      // @ts-expect-error another event's name
      context.emit("b-event", { n: 1 })
      // @ts-expect-error the event's payload, without the handle Repo adds
      context.emit("a-event", { n: "1" })
    },
  },
})
const badMember = defineExtension<ASpec>({
  members: {
    a: context => String(context.documentId),
    // @ts-expect-error not a member of the spec
    other(context) {},
  },
})
const badReturn = defineExtension<ASpec>({
  members: {
    // @ts-expect-error the spec's `a` returns a string
    a: () => 1,
  },
})
void [defined, badMember, badReturn]

// A member generic in the calling handle's document type declares it as
// `this`; callers get their own document type, the implementation `unknown`.
interface BookmarkSession extends SedimentreeSession {
  findBookmark(label: string): Promise<UrlHeads | undefined>
}
interface BookmarkSpec {
  session: BookmarkSession
  members: {
    openBookmark<T>(
      this: DocHandle<T>,
      label: string
    ): Promise<DocHandle<T> | undefined>
    label(this: DocHandle<unknown>, prefix: string): string
  }
}
const bookmarks = defineExtension<BookmarkSpec>({
  members: {
    async openBookmark(context, handle, label) {
      const heads = await context.requireSession().findBookmark(label)
      return heads && handle.view(heads)
    },
    label: (_context, handle, prefix) => prefix + handle.url,
  },
})
class BookmarkBackend extends MemoryBackend {
  readonly handleExtensions = provides(bookmarks)
}
async function bookmarkTypes() {
  const handle = await new Repo({ backend: new BookmarkBackend() }).find<Doc>(
    url
  )
  const whole: DocHandle<Doc> | undefined = await handle.openBookmark("v1")
  const title: DocHandle<string> | undefined = await handle
    .sub("title")
    .openBookmark("v1")
  handle.label("x").toUpperCase()
  // @ts-expect-error the bookmark is of a Doc
  const wrong: DocHandle<number> | undefined = await handle.openBookmark("v1")
  void [whole, title, wrong]
}
defineExtension<{ members: { first<T>(this: DocHandle<T>): T } }>({
  members: {
    // @ts-expect-error the implementation sees the document as `unknown`
    first: (_context, handle): string => handle.doc(),
  },
})
defineExtension<{ members: { first<T>(): T } }>({
  // @ts-expect-error a generic member without a `this` handle
  members: { first: () => undefined as never },
})
defineExtension<{ members: { first<T>(this: { n: T }): T } }>({
  // @ts-expect-error a `this` that is not a handle
  members: { first: () => undefined as never },
})
void bookmarkTypes

// ExtensionEvent names one extension's events: its kind and payload are
// typed, and the base session accepts it.
declare const aEvent: ExtensionEvent<"a", { n: number }>
aEvent.payload.n.toFixed()
const kindA: "a" = aEvent.kind
const onBase: SedimentreeEvent | ExtensionEvent = aEvent
const wrongPayload: ExtensionEvent<"a", { n: number }> = {
  type: "extension",
  sequence: 1,
  kind: "a",
  // @ts-expect-error the payload's type is checked
  payload: { n: "1" },
}
void [kindA, onBase, wrongPayload]

// ExtensionsOf reads a backend type's spec: its extensions', intersected; an
// undeclared backend gives `{}`.
const specOfA: Equal<ExtensionsOf<BackendA>, ASpecFull> = true
const specOfAB: Equal<ExtensionsOf<BackendAB>, ASpecFull & BSpec> = true
const specOfMemory: Equal<ExtensionsOf<MemoryBackend>, {}> = true
void [specOfA, specOfAB, specOfMemory]

// provides() reads each extension's spec. An extension without one, or
// typed loosely, adds nothing and leaves the others intact.
declare const untypedExt: HandleExtension
declare const anyExt: AnyHandleExtension
const fromDefined = provides(defined, extB)
const specOfDefined: Equal<
  ExtensionsOf<{ handleExtensions: typeof fromDefined } & MemoryBackend>,
  ASpecFull & BSpec
> = true
const withUntyped = provides(extA, untypedExt, anyExt)
const specWithUntyped: Equal<
  ExtensionsOf<{ handleExtensions: typeof withUntyped } & MemoryBackend>,
  ASpecFull
> = true
const none = provides()
const specOfNone: Equal<
  ExtensionsOf<{ handleExtensions: typeof none } & MemoryBackend>,
  {}
> = true
// The spec is inferred, not declared.
// @ts-expect-error
provides<ASpec>(untypedExt)
void [specOfDefined, specWithUntyped, specOfNone]

void [common, members, Serving, NotServing]

// SessionFor and EventFor work out a backend's session and events from its
// extensions: what each needs of a session, and one event per received kind.
interface CountSpec {
  receives: { count: { count: number } }
  members: { docsOpened(): number }
}
class Derived extends MemoryBackend {
  readonly handleExtensions = provides(
    extA,
    // Defined here, so its methods can use the backend itself.
    defineExtension<CountSpec>({
      members: { docsOpened: () => this.#opened },
      receive: { count: (_context, payload) => void payload.count.toFixed() },
    })
  )
  #opened = 0
  override open(id: SedimentreeId): SessionFor<Derived> {
    this.#opened++
    return Object.assign(super.open(id) as SessionFor<Derived>, {
      ping: async () => 1,
    })
  }
}
declare const derivedSession: SessionFor<Derived>
// What extension `a` needs is there.
void derivedSession.ping("x")
declare const derivedEvent: EventFor<Derived>
if (derivedEvent.type === "extension" && derivedEvent.kind === "a")
  derivedEvent.payload.n.toFixed()
if (derivedEvent.type === "extension" && derivedEvent.kind === "count")
  derivedEvent.payload.count.toFixed()
const sendCount: EventFor<Derived> = {
  type: "extension",
  sequence: 1,
  kind: "count",
  payload: { count: 1 },
}
const sendWrong: EventFor<Derived> = {
  type: "extension",
  sequence: 1,
  kind: "a",
  // @ts-expect-error count's payload under a's kind
  payload: { count: 1 },
}
const sendUnknown: EventFor<Derived> = {
  type: "extension",
  sequence: 1,
  // @ts-expect-error a kind no listed extension has
  kind: "other",
  // @ts-expect-error nor a payload of one
  payload: 1,
}
// Handles get both extensions' members.
async function derivedHandles() {
  const handle = await new Repo({ backend: new Derived() }).find<Doc>(url)
  handle.a()
  handle.docsOpened().toFixed()
}
class Forgetful extends MemoryBackend {
  readonly handleExtensions = provides(extA)
  override open(id: SedimentreeId): SessionFor<Forgetful> {
    // @ts-expect-error its sessions lack what extension `a` needs
    return super.open(id)
  }
}
void [sendCount, sendWrong, sendUnknown, derivedHandles, Forgetful]

// A subclass may list more extensions than its parent.
class DerivedMore extends Derived {
  override readonly handleExtensions = provides(
    extA,
    defineExtension<CountSpec>({
      members: { docsOpened: () => 0 },
      receive: { count: () => {} },
    }),
    defineExtension<{ members: { label(): string } }>({
      members: { label: () => "x" },
    })
  )
}
async function moreHandles() {
  const handle = await new Repo({ backend: new DerivedMore() }).find<Doc>(url)
  handle.label().toUpperCase()
}

// A methods-only spec matches the Repo inferred from it, both ways.
interface PingOnly {
  members: { ping(): number }
}
const pingOnly = defineExtension<PingOnly>({ members: { ping: () => 1 } })
class PingOnlyBackend extends MemoryBackend {
  readonly handleExtensions = provides(pingOnly)
}
const inferredPing = new Repo({ backend: new PingOnlyBackend() })
const namedPing: Repo<PingOnly> = inferredPing
const backToInferred: typeof inferredPing = namedPing

// A record annotated with its type is checked as defineExtension checks it:
// the spec's members, and a receiver for each kind it receives.
const annotated: HandleExtension<ASpecFull> = {
  members: { a: () => "x" },
  receive: { a: (_context, payload) => void payload.n.toFixed() },
}
const noMembers: HandleExtension<ASpecFull> = {
  // @ts-expect-error the spec's `a` is missing
  members: {},
}
// @ts-expect-error a spec that receives needs its receivers
const noReceivers: HandleExtension<ASpecFull> = { members: { a: () => "x" } }
const unexpected: HandleExtension<ASpec> = {
  members: { a: () => "x" },
  // @ts-expect-error nor may one that receives nothing have any
  receive: { a: () => {} },
}
const wrongKind: HandleExtension<ASpecFull> = {
  members: { a: () => "x" },
  // @ts-expect-error a receiver for each of the spec's kinds, and no others
  receive: { b: () => {} },
}
const greedy: HandleExtension<ASpecFull> = {
  members: { a: () => "x" },
  receive: {
    // @ts-expect-error a receiver may not demand more than the spec's payload
    a: (_context, _payload: { n: number; label: string }) => {},
  },
}

// An optional kind still needs its receiver, which gets the payload
// without `undefined`; its backend can still send it.
interface MaybeSpec {
  receives: { maybe?: { n: number } }
}
const maybe = defineExtension<MaybeSpec>({
  members: {},
  receive: { maybe: (_context, payload) => void payload.n.toFixed() },
})
// @ts-expect-error the optional kind's receiver is missing
defineExtension<MaybeSpec>({ members: {}, receive: {} })
class MaybeBackend extends MemoryBackend {
  readonly handleExtensions = provides(maybe)
}
const sendMaybe: EventFor<MaybeBackend> = {
  type: "extension",
  sequence: 1,
  kind: "maybe",
  payload: { n: 1 },
}
// Kinds must be named strings: an index signature or a number is rejected.
defineExtension<{ receives: Record<string, number> }>({
  members: {},
  // @ts-expect-error receives does not name its kinds
  receive: { any: () => {} },
})
defineExtension<{ receives: { 7: number } }>({
  members: {},
  // @ts-expect-error a kind is not a string
  receive: { 7: () => {} },
})
// A spec without members takes `members: {}`: a method it does not list
// would be on handles but not in their type.
defineExtension<{}>({ members: {} })
// @ts-expect-error not in the spec
defineExtension<{}>({ members: { helper: () => 1 } })
// @ts-expect-error not a record
const notMembers: HandleExtension = { members: false }

// A session union is one of its members, not just what they share.
interface Live extends SedimentreeSession {
  send(): void
}
interface Queued extends SedimentreeSession {
  sendLater(): void
}
class Sending extends MemoryBackend {
  readonly handleExtensions = provides(
    defineExtension<{ session: Live | Queued }>({ members: {} })
  )
}
const base: Omit<SedimentreeSession, "events"> = {
  markReady() {},
  close: async () => {},
}
const events = (async function* () {})()
const live: SessionFor<Sending> = { ...base, events, send() {} }
// @ts-expect-error neither kind of session
const neither: SessionFor<Sending> = { ...base, events }
void [live, neither]

// A list element that may be one of several extensions: the session must
// serve each, and each kind keeps its own payload.
interface SessionC extends SedimentreeSession {
  pong(): void
}
interface CSpec {
  session: SessionC
  receives: { c: { s: string } }
  members: { c(): void }
}
declare const extC: HandleExtension<CSpec>
declare const flag: boolean
class Either extends MemoryBackend {
  readonly handleExtensions = provides(flag ? extA : extC)
}
declare const eitherSession: SessionFor<Either>
void eitherSession.ping("x")
eitherSession.pong()
const eitherC: EventFor<Either> = {
  type: "extension",
  sequence: 1,
  kind: "c",
  payload: { s: "x" },
}
const eitherMixed: EventFor<Either> = {
  type: "extension",
  sequence: 1,
  kind: "a",
  // @ts-expect-error c's payload under a's kind
  payload: { s: "x" },
}
void [
  moreHandles,
  backToInferred,
  annotated,
  noMembers,
  noReceivers,
  unexpected,
  wrongKind,
  greedy,
  sendMaybe,
  notMembers,
  eitherC,
  eitherMixed,
]
