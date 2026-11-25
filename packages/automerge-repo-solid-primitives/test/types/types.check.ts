// Compile-time checks of how the primitives are typed.
// Not a test: checked by `pnpm lint`.
import {
  automerge,
  Handle,
  MemoryBackend,
  Repo,
  type DocType,
  type DocTypeHelpers,
  type DocumentUrl,
  type HandleKind,
  type Shaped,
} from "@automerge/automerge-repo"
import {
  createRepoPrimitives,
  useDocHandle,
  useDocSignal,
  useDocument,
  useRepo,
} from "../../src/index.js"
import { repo, type Todo } from "./extension.js"

declare const url: any

// Plain outside the factory.
// @ts-expect-error
useDocHandle<Todo>(url)()?.ping()
// @ts-expect-error
useDocument<Todo>(url)[1]()?.ping()
// @ts-expect-error
useDocSignal<Todo>(url)[1]()?.ping()
const plainRepo: Repo = useRepo()
useRepo<typeof repo>().handles

// The factory infers from the Repo, or takes its type.
const primitives = createRepoPrimitives(repo)
primitives.useDocHandle<Todo>(url)()?.ping().toUpperCase()
primitives.useDocument<Todo>(url)[1]()?.ping()
primitives.useDocSignal<Todo>(url)[0]()?.title
primitives.RepoProvider({ value: repo })
const memoryRepo = new Repo({ backend: new MemoryBackend() })
// @ts-expect-error its provider rejects a plain Repo
primitives.RepoProvider({ value: memoryRepo })
// @ts-expect-error the Repo comes from the provider
primitives.useDocHandle<Todo>(url, { repo })
createRepoPrimitives<typeof repo>().useDocHandle<Todo>(url)()?.ping()

// The handle-taking primitives come from the factory too, and take its handles.
const typedHandle = primitives.useDocHandle<Todo>(url)
primitives.createDocSignal(typedHandle)()?.title satisfies string | undefined
primitives.createDocumentProjection(typedHandle)()?.title
const loaded = typedHandle()!
primitives.makeDocSignal(loaded)()?.title
primitives.makeDocumentProjection(loaded).title satisfies string
loaded.on("change", payload => void primitives.autoproduce(payload))

void plainRepo

// Doc types other than Automerge, with `{ docType }` as `repo.find` takes.
declare class CounterHandle extends Handle<number, number> {
  increment(): Promise<void>
}
interface Counter extends HandleKind {
  readonly scheme: "counter"
  readonly handle: CounterHandle
}
declare const counterType: DocType<
  unknown,
  number,
  number,
  number,
  "counter",
  typeof CounterHandle
> &
  DocTypeHelpers<CounterHandle, "counter">
const counter = counterType.as<Counter>()
declare const counterUrl: DocumentUrl<"counter">

useDocHandle(counterUrl, { docType: counter })()?.increment()
// @ts-expect-error a plain handle
useDocHandle(counterUrl, { docType: counter })()?.ping()
// @ts-expect-error a counter's URL needs its doc type
useDocHandle(counterUrl)
useDocument(counterUrl, { docType: counter })[0]() satisfies number | undefined
useDocSignal(counterUrl, { docType: counter })[0]() satisfies number | undefined
useDocument(url, { docType: automerge.of<Todo>() })[0]()?.title satisfies
  | string
  | undefined

primitives.useDocHandle(counterUrl, { docType: counter })()?.ping()
const [count, counterHandle] = primitives.useDocument(counterUrl, {
  docType: counter,
})
count() satisfies number | undefined
counterHandle()?.increment()
counterHandle()?.ping()
primitives.useDocSignal(counterUrl, { docType: counter })[1]()?.ping()
primitives.createDocSignal(counterHandle)() satisfies number | undefined
primitives.makeDocSignal(counterHandle()!)() satisfies number | undefined
// @ts-expect-error a projection is of an Automerge document
primitives.createDocumentProjection(counterHandle)

// A doc type whose handles are generic in the shape, given with `of`.
declare class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K]
}
interface Register extends Shaped {
  readonly scheme: "register"
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
declare const registerUrl: DocumentUrl<"register">

const [todo, registerHandle] = primitives.useDocument(registerUrl, {
  docType: register.of<Todo>(),
})
todo()?.title satisfies string | undefined
registerHandle()?.get("title") satisfies string | undefined
registerHandle()?.ping()
// @ts-expect-error not a key
useDocHandle(registerUrl, { docType: register.of<Todo>() })()?.get("nope")
