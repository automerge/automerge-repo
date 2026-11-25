// Compile-time checks of how the hooks are typed.
// Not a test: checked by `pnpm lint`.
import {
  automerge,
  useDocHandle,
  useDocHandles,
  useDocument,
  useDocuments,
  useRepo,
  usePresence,
  Handle,
  Repo,
  createRepoHooks,
  MemoryBackend,
  type AutomergeUrl,
  type DocHandle,
  type DocType,
  type DocTypeHelpers,
  type HandleKind,
  type Shaped,
  type PresenceInbound,
} from "@automerge/react"
import {
  provides,
  type HandleExtension,
} from "@automerge/automerge-repo/sedimentree"
import type { ReactElement } from "react"
type Todo = { title: string }

/** Stands in for a backend with ephemeral messaging, such as Subduction. */
interface EphemeralSpec {
  members: { broadcast(message: unknown): void }
  events: { "ephemeral-message": PresenceInbound }
}
declare const ephemeral: HandleExtension<EphemeralSpec>
class EphemeralBackend extends MemoryBackend {
  readonly handleExtensions = provides(ephemeral)
}
const repo = new Repo({ backend: new EphemeralBackend() })
export function component(url: any) {
  const h = useDocHandle<Todo>(url, { suspense: true })
  // @ts-expect-error a plain handle by default
  h.broadcast("x")
  // @ts-expect-error plain handle not for presence
  usePresence({ handle: h, initialState: {} })
  const r: Repo = useRepo()
  useRepo<typeof repo>().handles
  const {
    RepoProvider,
    useDocHandle: useTyped,
    useDocHandles: useTypedMany,
    useDocument: useTypedDoc,
    useDocuments: useTypedDocs,
    usePresence: useTypedPresence,
  } = createRepoHooks(repo)
  const typed = useTyped<Todo>(url, { suspense: true })
  typed.broadcast("a")
  usePresence({ handle: typed, initialState: {} })
  useTypedPresence({ handle: typed, initialState: {} })
  // @ts-expect-error plain handle not for presence
  useTypedPresence({ handle: h, initialState: {} })
  const [doc, change] = useTypedDoc<Todo>(url, { suspense: true })
  doc.title satisfies string
  void change(d => void (d.title = "x"))
  const [maybeDoc] = useTypedDoc<Todo>(url)
  // @ts-expect-error may be loading
  maybeDoc.title
  useTypedDocs<Todo>([url])[0].get(url)?.title satisfies string | undefined
  useTyped<Todo>(url)?.broadcast("a")
  useTypedMany<Todo>([url]).get(url)?.broadcast("a")
  const ok: ReactElement = RepoProvider({ value: repo })
  const memoryRepo = new Repo({ backend: new MemoryBackend() })
  // @ts-expect-error provider rejects a plain Repo
  RepoProvider({ value: memoryRepo })
  // Known gap: inline, the Repo's spec is taken from the provider's type, so
  // a plain construction passes. A Repo built elsewhere does not (above).
  RepoProvider({ value: new Repo({ backend: new MemoryBackend() }) })
  const typeOnly = createRepoHooks<typeof repo>()
  typeOnly.useDocHandle<Todo>(url, { suspense: true }).broadcast("t")
  const byName = createRepoHooks<Repo<EphemeralSpec>>()
  byName.useDocHandle<Todo>(url, { suspense: true }).broadcast("t")
  byName.RepoProvider({ value: repo })
  void [r, ok]
}

// Doc types other than Automerge, with `{ docType }` as `repo.find` takes.
declare class CounterHandle extends Handle<number, number> {
  increment(): Promise<void>
}
interface Counter extends HandleKind {
  readonly name: "counter"
  readonly handle: CounterHandle
}
declare const counter: DocType<
  unknown,
  number,
  number,
  number,
  "counter",
  typeof CounterHandle
> &
  DocTypeHelpers<CounterHandle, "counter">
const counterType = counter.as<Counter>()
declare const counterUrl: AutomergeUrl<"counter">
declare const todoUrl: AutomergeUrl<"automerge">
export function docTypes(url: AutomergeUrl) {
  const plain = useDocHandle(counterUrl, {
    suspense: true,
    docType: counterType,
  })
  void plain.increment()
  plain satisfies DocHandle<unknown, {}, Counter>
  // @ts-expect-error a plain handle
  plain.broadcast("x")
  useDocHandle(url, { docType: counterType })?.increment()
  useDocHandle(counterUrl, { suspense: false, docType: counterType })
  // @ts-expect-error a counter's URL needs its doc type
  useDocHandle(counterUrl, { suspense: true })
  // @ts-expect-error an Automerge document's URL is not a counter's
  useDocHandle(todoUrl, { docType: counterType })

  const [value, change] = useDocument(counterUrl, {
    suspense: true,
    docType: counterType,
  })
  value satisfies number
  void change(1)
  // @ts-expect-error a counter changes by a number
  void change("x")
  const [maybe] = useDocument(counterUrl, { docType: counterType })
  // @ts-expect-error may be loading
  maybe.toFixed()

  // `automerge.of<T>()` is the same as `<T>`.
  const [todo, changeTodo] = useDocument(url, {
    suspense: true,
    docType: automerge.of<Todo>(),
  })
  todo.title satisfies string
  void changeTodo(d => void (d.title = "x"))
  useDocument<Todo>(url, { suspense: true })[0].title satisfies string

  useDocHandles([counterUrl], { docType: counterType })
    .get(counterUrl)
    ?.increment()
  const [values, changeOne] = useDocuments([counterUrl], {
    docType: counterType,
  })
  values.get(counterUrl) satisfies number | undefined
  void changeOne(counterUrl, 1)

  const typed = createRepoHooks(repo)
  const counterHandle = typed.useDocHandle(counterUrl, {
    suspense: true,
    docType: counterType,
  })
  void counterHandle.increment()
  counterHandle.broadcast("x")
  typed
    .useDocHandles([counterUrl], { docType: counterType })
    .get(counterUrl)
    ?.broadcast("x")
  const [typedValue] = typed.useDocument(counterUrl, {
    suspense: true,
    docType: counterType,
  })
  typedValue satisfies number
}

// A doc type whose handles are generic in the shape, given with `of`.
declare class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K]
}
interface Register extends Shaped {
  readonly name: "register"
  readonly handle: RegisterHandle<this["Shape"]>
}
declare const registerType: DocType<
  unknown,
  unknown,
  unknown,
  unknown,
  "register",
  typeof RegisterHandle
> &
  DocTypeHelpers<RegisterHandle<unknown>, "register">
const register = registerType.as<Register>()
declare const registerUrl: AutomergeUrl<"register">

export function shaped() {
  const handle = useDocHandle(registerUrl, {
    suspense: true,
    docType: register.of<Todo>(),
  })
  handle.get("title") satisfies string
  // @ts-expect-error not a key
  handle.get("nope")
  const [todo, change] = useDocument(registerUrl, {
    suspense: true,
    docType: register.of<Todo>(),
  })
  todo.title satisfies string
  void change({ title: "x" })
  // @ts-expect-error a register's URL is not a counter's
  useDocHandle(registerUrl, { docType: counterType })
}
