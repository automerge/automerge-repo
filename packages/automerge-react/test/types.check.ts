// Compile-time checks of how the hooks are typed.
// Not a test: checked by `pnpm lint`.
import {
  useDocHandle,
  useRepo,
  usePresence,
  Repo,
  createRepoHooks,
  SubductionBackend,
  type SubductionExtensions,
  MemoryBackend,
} from "@automerge/react"
import type { ReactElement } from "react"
type Todo = { title: string }
declare const backend: SubductionBackend
const repo = new Repo({ backend })
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
  const byName = createRepoHooks<Repo<SubductionExtensions>>()
  byName.useDocHandle<Todo>(url, { suspense: true }).broadcast("t")
  byName.RepoProvider({ value: repo })
  void [r, ok]
}
