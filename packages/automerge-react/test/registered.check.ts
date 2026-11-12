// Compile-time checks of the hooks' typing with a Repo type registered. Its
// own program, since a registration applies to a whole program.
// Not a test: checked by `pnpm lint`.
import {
  Repo,
  SubductionBackend,
  useDocHandle,
  useDocHandles,
  useRepo,
  usePresence,
  createRepoHooks,
  type HandleOf,
} from "@automerge/react"
type Todo = { title: string }
declare const backend: SubductionBackend
const repo = new Repo({ backend })
declare module "@automerge/react" {
  interface Register {
    repo: typeof repo
  }
}
export function component(url: any) {
  const h = useDocHandle<Todo>(url, { suspense: true })
  h.broadcast("registered")
  h.doc()?.title
  useRepo().handles
  useDocHandles<Todo>([url]).get(url)?.broadcast("x")
  usePresence({ handle: h, initialState: {} })
  // explicit plain handle type overrides registration
  const plain = useDocHandle<HandleOf<Repo, Todo>>(url, { suspense: true })
  // @ts-expect-error
  plain.broadcast("no")
  const hooks = createRepoHooks(repo)
  hooks.useDocHandle<Todo>(url, { suspense: true }).broadcast("factory")
}
