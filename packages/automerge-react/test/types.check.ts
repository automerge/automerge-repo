// Compile-time checks of how the hooks are typed.
// Not a test: checked by `pnpm lint`.
import {
  useDocHandle,
  useRepo,
  usePresence,
  Repo,
  createRepoHooks,
  SubductionBackend,
  type DocHandle,
  type HandleOf,
  type SubductionExtensions,
  MemoryBackend,
} from "@automerge/react"
import type { ReactElement } from "react"
type Todo = { title: string }
type Note = { text: string }
declare const backend: SubductionBackend
const repo = new Repo({ backend })
type AppHandle<T> = HandleOf<typeof repo, T>
export function component(url: any) {
  const h = useDocHandle<Todo>(url, { suspense: true })
  // @ts-expect-error a plain handle by default
  h.broadcast("x")
  // @ts-expect-error plain handle not for presence
  usePresence({ handle: h, initialState: {} })
  const c = useDocHandle<AppHandle<Todo>>(url, { suspense: true })
  c.broadcast("c")
  usePresence({ handle: c, initialState: {} })
  const maybe = useDocHandle<AppHandle<Todo>>(url)
  maybe?.broadcast("c")
  // A union or `any` document type is one handle, not one per member.
  const either = useDocHandle<Todo | Note>(url, { suspense: true })
  either satisfies DocHandle<Todo | Note>
  either.change(doc => void doc)
  // @ts-expect-error a handle, not `any`
  useDocHandle<any>(url, { suspense: true }).notAMethod()
  const r: Repo = useRepo()
  useRepo<typeof repo>().handles
  const {
    RepoProvider,
    useDocHandle: useTyped,
    useDocHandles: useTypedMany,
  } = createRepoHooks(repo)
  useTyped<Todo>(url, { suspense: true }).broadcast("a")
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
