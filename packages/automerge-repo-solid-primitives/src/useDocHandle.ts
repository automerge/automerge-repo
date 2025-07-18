import type {
  AutomergeUrl,
  DocHandle,
  DocumentId,
  HandleState,
} from "@automerge/automerge-repo/slim"
import {
  createEffect,
  createResource,
  useContext,
  type Resource,
} from "solid-js"
import { RepoContext } from "./context.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
const readyStates = ["ready", "deleted", "unavailable"] as HandleState[]
const badStates = ["deleted", "unavailable"] as HandleState[]

/**
 * get a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 * from an
 * [AutomergeUrl](https://automerge.org/automerge-repo/types/_automerge_automerge_repo.AutomergeUrl.html)
 * as a
 * [Resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).
 * Waits for the handle to be
 * [ready](https://automerge.org/automerge-repo/variables/_automerge_automerge_repo.HandleState-1.html).
 */
export default function useDocHandle<T>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): Resource<DocHandle<T> | undefined> {
  const contextRepo = useContext(RepoContext)

  if (!options?.repo && !contextRepo) {
    throw new Error("use outside <RepoContext> requires options.repo")
  }

  const repo = (options?.repo || contextRepo)!

  function getExistingHandle() {
    if (options?.["~skipInitialValue"]) return undefined
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) return undefined
    try {
      const documentId = new URL(unwrappedURL).pathname as DocumentId
      const existingHandle = repo.handles[documentId]
      if (existingHandle?.isReady()) {
        return existingHandle as DocHandle<T>
      }
    } catch (error) {
      console.error("Error parsing URL:", error)
    }
  }

  const [handle, { mutate }] = createResource(
    url,
    async url => {
      const handle = await repo.find<T>(url, {
        allowableStates: readyStates,
      })
      const reject = (state: HandleState) =>
        Promise.reject(new Error(`document not available: [${state}]`))

      if (handle.isReady()) {
        return handle
      } else if (handle.inState(badStates)) {
        return reject(handle.state)
      }

      return handle.whenReady(readyStates).then(() => {
        if (handle.isReady()) {
          return handle
        }
        return reject(handle.state)
      })
    },
    {
      initialValue: getExistingHandle(),
    }
  )

  createEffect(() => {
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) {
      mutate()
    }
  })

  return handle
}
