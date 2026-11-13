// Compile-time checks of how the stores are typed, against the built
// package. Not a test: checked by `pnpm lint`.
import {
  MemoryBackend,
  Repo,
  type DocHandle,
  type HandleOf,
} from "@automerge/automerge-repo"
import {
  createAutomergeStore,
  document,
  getContextRepo,
  type AutomergeDocumentStore,
} from "../../dist/index.js"
import { repo, type Todo } from "./extension.js"

type AppHandle<T> = HandleOf<typeof repo, T>
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

  // document(): plain by default, typed by a handle type.
  // @ts-expect-error
  ;(await document<Todo>(url))?.handle.ping()
  const store = await document<AppHandle<Todo>>(url)
  store?.handle.ping()
  store?.change(doc => {
    doc.title = "x"
  })
  // A union or `any` document type is one handle, not one per member.
  type Note = { text: string }
  ;(await document<Todo | Note>(url))?.handle satisfies
    | DocHandle<Todo | Note>
    | undefined
  // @ts-expect-error a handle, not `any`
  ;(await document<any>(url))?.handle.notAMethod()
  const plainRepo: Repo = getContextRepo()
  getContextRepo<typeof repo>().handles

  // Existing annotations keep working.
  const annotated: AutomergeDocumentStore<Todo> | null =
    await document<Todo>(url)
  void [plainRepo, annotated]
}
void checks
