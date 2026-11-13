// Compile-time checks of how handle extensions type Repos and handles.
// Not a test: checked by `pnpm lint`.
import { EventEmitter } from "eventemitter3"
import { Repo } from "../src/Repo.js"
import type { DocHandle, ExtendedHandle } from "../src/DocHandle.js"
import type { AsHandle, HandleOf } from "../src/Repo.js"
import type { DocHandleChangePayload } from "../src/DocHandleEvents.js"
import type { DocumentQuery, QueryState } from "../src/DocumentQuery.js"
import type {
  ExtensionsOf,
  HandleExtension,
  SedimentreeBackend,
  SedimentreeId,
  SedimentreeSession,
} from "../src/sedimentree/index.js"
import { defineExtension } from "../src/sedimentree/defineExtension.js"
import { provides } from "../src/sedimentree/backend.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"

type Doc = { title: string }
interface ASpec {
  members: { a(): string }
  events: { "a-event": { n: number } }
}
interface BSpec {
  members: { b(): void }
  events: {}
}
/** The session extension `a` needs of its backend. */
interface SessionA extends SedimentreeSession {
  ping(text: string): Promise<number>
}
declare const extA: HandleExtension<SessionA, ASpec["events"], { n: number }>
declare const extB: HandleExtension
class BackendA extends MemoryBackend {
  readonly handleExtensions = provides<ASpec>(extA)
}
/** Several extensions declare the intersection of their specs. */
class BackendAB extends MemoryBackend {
  readonly handleExtensions = provides<ASpec & BSpec>(extA, extB)
}
declare const loose: SedimentreeBackend
const url = "automerge:x" as any

const plainRepo = new Repo()
const repoA = new Repo({ backend: new BackendA() })
const repoAB = new Repo({ backend: new BackendAB() })
const repoLoose = new Repo({ backend: loose })
declare const hPlain: DocHandle<Doc>
declare const hA: ExtendedHandle<Doc, ASpec>
declare const hAB: ExtendedHandle<Doc, ASpec & BSpec>

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
  ExtendedHandle<Doc, ASpec>,
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
const bad3: ExtendedHandle<Doc, ASpec> = hPlain
// @ts-expect-error
const bad4: ExtendedHandle<Doc, ASpec & BSpec> = hA
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
  handle.on("change", () => {}).b()
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

// AsHandle: a document type or a handle type, as a handle.
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
    ? true
    : false
// A handle type is kept.
const keepsHandle: Equal<
  AsHandle<ExtendedHandle<Doc, ASpec>, Repo>,
  ExtendedHandle<Doc, ASpec>
> = true
// `any` is a document type, so it gives a handle, not `any`.
declare const ofAny: AsHandle<any, typeof repoA>
ofAny.a()
// @ts-expect-error
ofAny.notAMember()
// A union of document types gives one handle of the union.
const ofUnion: Equal<
  AsHandle<Doc | { other: number }, typeof repoA>,
  ExtendedHandle<Doc | { other: number }, ASpec>
> = true
// HandleOf names a Repo's handle type.
const ofRepo: Equal<
  HandleOf<typeof repoA, Doc>,
  ExtendedHandle<Doc, ASpec>
> = true
void [keepsHandle, ofUnion, ofRepo]

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
repoA.on("document", plainListener)
hA.on("delete", plainListener)
hA.on("change", (payload: DocHandleChangePayload<Doc>) => payload.patches)

void [ok, bad1, bad2, bad3, bad4, bad5, bad6, gap1, gap2, bad9, okBoth]

// Inside an extension, the session and its declared events are typed.
const implemented = {
  kind: "a" as const,
  extend: (base, context) =>
    class extends base {
      a() {
        return context(this)
          .session?.ping("x")
          .then(n => n.toFixed())
      }
    },
  receive(context, payload) {
    payload.n.toFixed()
    void context.session?.ping("x")
    context.emit("a-event", { n: payload.n })
    // @ts-expect-error another event's name
    context.emit("b-event", { n: 1 })
    // @ts-expect-error the event's payload, without the handle Repo adds
    context.emit("a-event", { n: "1" })
  },
} satisfies HandleExtension<SessionA, ASpec["events"], { n: number }>

// A backend that declares its sessions as what its extension needs has that
// checked where it opens them.
class Serving extends MemoryBackend {
  readonly handleExtensions = provides<ASpec>(extA)
  override open(id: SedimentreeId): SessionA {
    return Object.assign(super.open(id), { ping: async () => 1 })
  }
}
class NotServing extends MemoryBackend {
  readonly handleExtensions = provides<ASpec>(extA)
  override open(id: SedimentreeId): SessionA {
    // @ts-expect-error its sessions lack `ping`
    return super.open(id)
  }
}

// defineExtension: the context is typed, members are checked against the
// spec, and the declared events are the only ones it can emit.
const defined = defineExtension<SessionA, ASpec, { n: number }>({
  kind: "a",
  members: {
    a(context) {
      const session = context.requireSession()
      void session.ping("x")
      return "a"
    },
  },
  receive(context, payload) {
    payload.n.toFixed()
    context.emit("a-event", { n: payload.n })
    // @ts-expect-error another event's name
    context.emit("b-event", { n: 1 })
    // @ts-expect-error the event's payload, without the handle Repo adds
    context.emit("a-event", { n: "1" })
  },
})
const badMember = defineExtension<SessionA, ASpec>({
  kind: "a",
  members: {
    a: context => String(context.documentId),
    // @ts-expect-error not a member of the spec
    other(context) {},
  },
})
const badReturn = defineExtension<SessionA, ASpec>({
  kind: "a",
  members: {
    // @ts-expect-error the spec's `a` returns a string
    a: () => 1,
  },
})
void [defined, badMember, badReturn]

// ExtensionsOf reads a backend type's spec; an undeclared backend gives `{}`.
const specOfA: Equal<ExtensionsOf<BackendA>, ASpec> = true
const specOfAB: Equal<ExtensionsOf<BackendAB>, ASpec & BSpec> = true
const specOfMemory: Equal<ExtensionsOf<MemoryBackend>, {}> = true
void [specOfA, specOfAB, specOfMemory]

void [common, members, implemented, Serving, NotServing]
