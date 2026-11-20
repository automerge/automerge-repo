// Compile-time checks of how the hooks are typed.
// Not a test: checked by `pnpm lint`.
import {
  useDocHandle,
  useRepo,
  usePresence,
  Repo,
  createRepoHooks,
  MemoryBackend,
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
