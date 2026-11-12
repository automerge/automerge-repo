// Compile-time checks of how handle extensions type Repos and handles.
// Not a test: checked by `pnpm lint`.
import { EventEmitter } from "eventemitter3"
import { Repo } from "../src/Repo.js"
import type { DocHandle, ExtendedHandle } from "../src/DocHandle.js"
import type { AsHandle } from "../src/Repo.js"
import type { DocHandleChangePayload } from "../src/DocHandleEvents.js"
import type { DocumentQuery, QueryState } from "../src/DocumentQuery.js"
import type {
  HandleExtension,
  SedimentreeBackend,
  SedimentreeEvent,
  SedimentreeId,
  SedimentreeSession,
} from "../src/sedimentree/index.js"
import { MemoryBackend } from "../src/sedimentree/memory/MemoryBackend.js"

declare module "../src/sedimentree/extension.js" {
  interface HandleExtensionTypes<T> {
    a: {
      members: { a(): T }
      events: { "a-event": (p: { n: number }) => void }
      inbound: { n: number }
    }
    b: { members: { b(): void }; events: {}; inbound: string }
  }
}
type Doc = { title: string }
/** The session extension `a` needs of its backend. */
interface SessionA extends SedimentreeSession {
  ping(text: string): Promise<number>
}
declare const extA: HandleExtension<"a", SessionA>
declare const extB: HandleExtension<"b">
class BackendA extends MemoryBackend {
  readonly handleExtensions = [extA] as const
}
class BackendAB extends MemoryBackend {
  readonly handleExtensions = [extA, extB] as const
}
declare const loose: SedimentreeBackend
const url = "automerge:x" as any

const plainRepo = new Repo()
const repoA = new Repo({ backend: new BackendA() })
const repoAB = new Repo({ backend: new BackendAB() })
const repoLoose = new Repo({ backend: loose })
declare const hPlain: DocHandle<Doc>
declare const hA: ExtendedHandle<Doc, "a">
declare const hAB: ExtendedHandle<Doc, "a" | "b">

// Extended things are accepted where plain ones, or ones with fewer
// extensions, are wanted.
const ok: [
  Repo,
  Repo,
  Repo<"a">,
  Repo,
  Repo<"a">[],
  DocHandle<Doc>,
  DocHandle<unknown>,
  DocHandle<any>,
  DocHandle<Doc, "a">,
  ExtendedHandle<unknown, "a">,
  DocHandle<Doc>[],
  DocumentQuery<Doc>,
  DocumentQuery<unknown>,
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
  hAB,
  [hA, hAB, hPlain],
  repoA.query<Doc>(url),
  repoA.query<Doc>(url),
  repoAB.query<Doc>(url).state(),
  repoA,
]

// The reverse is not.
// @ts-expect-error
const bad1: Repo<"a"> = plainRepo
// @ts-expect-error
const bad2: Repo<"a" | "b"> = repoA
// @ts-expect-error
const bad3: DocHandle<Doc, "a"> = hPlain
// @ts-expect-error
const bad4: DocHandle<Doc, "a" | "b"> = hA
// @ts-expect-error
const bad5: ExtendedHandle<Doc, "a"> = hPlain
// @ts-expect-error
const bad6: ExtendedHandle<Doc, "a" | "b"> = hA
// @ts-expect-error
const bad7: DocumentQuery<Doc, "a"> = plainRepo.query<Doc>(url)
// @ts-expect-error a backend typed loosely gives a plain Repo
const bad8: Repo<"a"> = repoLoose
const repoEither = new Repo({
  backend: Math.random() > 0.5 ? new BackendA() : new MemoryBackend(),
})
// @ts-expect-error a backend chosen at runtime gives a plain Repo if any choice is plain
const bad9: Repo<"a"> = repoEither

// @ts-expect-error nor does annotating a plain construction
const bad10: Repo<"a"> = new Repo()
const bad11: Repo<"a"> = new Repo({
  // @ts-expect-error
  backend: new MemoryBackend(),
})

// Known gap: this compiles, though the Repo is not sure to have both.
const gap2: Repo<"a" | "b"> = new Repo({
  backend: Math.random() > 0.5 ? new BackendA() : new BackendAB(),
})

// Members and events follow the document type, sub-handles and views.
async function members() {
  const handle = await repoAB.find<Doc>(url)
  handle.a().title satisfies string
  handle.sub("title").a() satisfies string
  handle.view(handle.heads()).b()
  handle.on("a-event", ({ n }) => n.toFixed())
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
  AsHandle<ExtendedHandle<Doc, "a">, Repo>,
  ExtendedHandle<Doc, "a">
> = true
// `any` is a document type, so it gives a handle, not `any`.
declare const ofAny: AsHandle<any, typeof repoA>
ofAny.a()
// @ts-expect-error
ofAny.notAMember()
// A union of document types gives one handle of the union.
const ofUnion: Equal<
  AsHandle<Doc | { other: number }, typeof repoA>,
  ExtendedHandle<Doc | { other: number }, "a">
> = true
void [keepsHandle, ofUnion]

// Event payloads carry the extended handle.
repoA.on("document", ({ handle }) => handle.a())
hA.on("change", ({ handle }) => handle.a().title)
hA.on("delete", ({ handle }) => handle.a())
hA.sub("title").on("heads-changed", ({ handle }) => handle.a().toUpperCase())
// @ts-expect-error
plainRepo.on("document", ({ handle }) => handle.a())
// @ts-expect-error
hPlain.on("change", ({ handle }) => handle.a())
// Listeners written against plain handles still attach.
const plainListener = ({ handle }: { handle: DocHandle<any> }) => handle.url
repoA.on("document", plainListener)
hA.on("delete", plainListener)
hA.on("change", (payload: DocHandleChangePayload<Doc>) => payload.patches)

void [ok, bad1, bad2, bad3, bad4, bad5, bad6, bad7, bad8, bad9, bad10, bad11]
void gap2
// Inside an extension, the session and the backend's events are typed.
const implemented: HandleExtension<"a", SessionA> = {
  kind: "a",
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
  },
}

// A backend that declares its sessions as what its extension needs has that
// checked where it opens them.
class Serving extends MemoryBackend {
  readonly handleExtensions = [extA] as const
  override open(id: SedimentreeId): SessionA {
    return Object.assign(super.open(id), { ping: async () => 1 })
  }
}
class NotServing extends MemoryBackend {
  readonly handleExtensions = [extA] as const
  override open(id: SedimentreeId): SessionA {
    // @ts-expect-error its sessions lack `ping`
    return super.open(id)
  }
}

// Extension events are typed by kind.
const events: SedimentreeEvent[] = [
  { type: "extension", sequence: 1, kind: "a", payload: { n: 1 } },
  { type: "extension", sequence: 1, kind: "b", payload: "x" },
  // @ts-expect-error a kind nobody declared
  { type: "extension", sequence: 1, kind: "nope", payload: 1 },
  // @ts-expect-error another kind's payload
  { type: "extension", sequence: 1, kind: "a", payload: "x" },
]
function read(event: SedimentreeEvent) {
  if (event.type === "extension" && event.kind === "a")
    event.payload.n.toFixed()
  if (event.type === "extension" && event.kind === "b")
    event.payload.toUpperCase()
}

void [members, implemented, Serving, NotServing, events, read]
