// Compile-time checks of the hooks' typing with no Repo type registered.
// Not a test: checked by `pnpm lint`.
import {
  useDocHandle,
  useRepo,
  usePresence,
  Repo,
  createRepoHooks,
  SubductionBackend,
  type HandleOf,
  MemoryBackend,
} from "@automerge/react"
import type { ReactElement } from "react"
type Todo = { title: string }
declare const backend: SubductionBackend
const repo = new Repo({ backend })
type AppHandle<T> = HandleOf<typeof repo, T>
export function component(url: any) {
  const h = useDocHandle<Todo>(url, { suspense: true })
  // @ts-expect-error nothing registered here
  h.broadcast("x")
  // @ts-expect-error plain handle not for presence
  usePresence({ handle: h, initialState: {} })
  const c = useDocHandle<AppHandle<Todo>>(url, { suspense: true })
  c.broadcast("c")
  usePresence({ handle: c, initialState: {} })
  const maybe = useDocHandle<AppHandle<Todo>>(url)
  maybe?.broadcast("c")
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
  // Also inline, where TypeScript could take the Repo's type from its use.
  // @ts-expect-error
  RepoProvider({ value: new Repo({ backend: new MemoryBackend() }) })
  const typeOnly = createRepoHooks<typeof repo>()
  typeOnly.useDocHandle<Todo>(url, { suspense: true }).broadcast("t")
  void [r, ok]
}
