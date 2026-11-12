// Compile-time checks of the primitives' typing with no Repo type registered.
// Not a test: checked by `pnpm lint`.
import { MemoryBackend, Repo, type HandleOf } from "@automerge/automerge-repo"
import {
  createRepoPrimitives,
  useDocHandle,
  useDocSignal,
  useDocument,
  useRepo,
} from "../../src/index.js"
import { repo, type Todo } from "./extension.js"

type AppHandle<T> = HandleOf<typeof repo, T>
declare const url: any

// Plain by default.
// @ts-expect-error
useDocHandle<Todo>(url)()?.ping()
const plainRepo: Repo = useRepo()

// A handle type gives that handle; the document type follows it.
useDocHandle<AppHandle<Todo>>(url)()?.ping().title
const [doc, handle] = useDocument<AppHandle<Todo>>(url)
doc()?.title satisfies string | undefined
handle()?.ping()
useDocSignal<AppHandle<Todo>>(url)[1]()?.ping()
useRepo<typeof repo>().handles

// The factory infers from the Repo, or takes its type.
const primitives = createRepoPrimitives(repo)
primitives.useDocHandle<Todo>(url)()?.ping().title
primitives.useDocument<Todo>(url)[1]()?.ping()
primitives.useDocSignal<Todo>(url)[0]()?.title
primitives.RepoProvider({ value: repo })
const memoryRepo = new Repo({ backend: new MemoryBackend() })
// @ts-expect-error its provider rejects a plain Repo
primitives.RepoProvider({ value: memoryRepo })
// @ts-expect-error the Repo comes from the provider
primitives.useDocHandle<Todo>(url, { repo })
createRepoPrimitives<typeof repo>().useDocHandle<Todo>(url)()?.ping()

void plainRepo
