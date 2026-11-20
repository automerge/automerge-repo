// Compile-time checks of how the primitives are typed.
// Not a test: checked by `pnpm lint`.
import { MemoryBackend, Repo } from "@automerge/automerge-repo"
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
