// Compile-time checks of how the stores are typed, against the built
// package. Not a test: checked by `pnpm lint`.
import {
  automerge,
  Handle,
  MemoryBackend,
  Repo,
  type AutomergeUrl,
  type DocType,
  type DocTypeHelpers,
  type HandleKind,
  type Shaped,
} from "@automerge/automerge-repo"
import {
  createAutomergeStore,
  document,
  getContextRepo,
  type AutomergeDocumentStore,
} from "../../dist/index.js"
import { repo, type Todo } from "./extension.js"

declare const url: any

async function checks() {
  // The factory is typed from its Repo.
  const stores = createAutomergeStore(repo)
  ;(await stores.create<Todo>()).handle.ping().toUpperCase()
  ;(await stores.find<Todo>(url))?.handle.ping()
  stores.getRepo().handles
  // A plain Repo gives plain handles.
  const plain = createAutomergeStore(new Repo({ backend: new MemoryBackend() }))
  // @ts-expect-error
  ;(await plain.create<Todo>()).handle.ping()

  // document(): plain handles.
  // @ts-expect-error
  ;(await document<Todo>(url))?.handle.ping()
  const plainRepo: Repo = getContextRepo()
  getContextRepo<typeof repo>().handles

  // Existing annotations keep working.
  const annotated: AutomergeDocumentStore<Todo> | null =
    await document<Todo>(url)
  void [plainRepo, annotated]

  // Doc types other than Automerge, with `{ docType }` as `repo.find` takes.
  const made = await stores.create(1, { docType: counter })
  made.handle.increment().then(() => made.handle.ping())
  void made.change(2)
  // @ts-expect-error a counter changes by a number
  void made.change("x")
  made.subscribe(value => value satisfies number | null)
  const found = await stores.find(counterUrl, { docType: counter })
  found?.handle.ping()
  // @ts-expect-error a counter's URL needs its doc type
  await stores.find(counterUrl)
  // @ts-expect-error a counter starts from a number
  await stores.create("x", { docType: counter })
  const viaDocument = await document(counterUrl, { docType: counter })
  void viaDocument?.handle.increment()
  // @ts-expect-error a plain handle
  viaDocument?.handle.ping()
  await document(counterUrl, { docType: counter, repo: plainRepo })
  // @ts-expect-error a counter's URL needs its doc type
  await document(counterUrl)

  // `automerge.of<T>()` is the same as `<T>`.
  const todo = await stores.create(
    { title: "x" },
    { docType: automerge.of<Todo>() }
  )
  todo.subscribe(value => value?.title satisfies string | undefined)
  void todo.change(d => void (d.title = "y"))
  todo.handle.ping()
}
void checks

declare class CounterHandle extends Handle<number, number> {
  increment(): Promise<void>
}
interface Counter extends HandleKind {
  readonly name: "counter"
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
declare const counterUrl: AutomergeUrl<"counter">

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

export async function shaped() {
  const stores = createAutomergeStore(repo)
  const store = await stores.find(registerUrl, {
    docType: register.of<Todo>(),
  })
  store?.handle.get("title") satisfies string | undefined
  store?.handle.ping()
  store?.url satisfies AutomergeUrl<"register"> | undefined
  store?.subscribe(value => value?.title satisfies string | undefined)
  void store?.change({ title: "x" })
  // @ts-expect-error a register holds a Todo
  void store?.change({ title: 1 })
}
