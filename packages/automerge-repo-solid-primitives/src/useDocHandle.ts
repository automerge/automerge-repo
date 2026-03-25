import type {
  AutomergeUrl,
  DocHandle,
  DocumentId,
  HandleState,
} from "@automerge/automerge-repo/slim"
import { createMemo, useContext, type Accessor } from "solid-js"
import { RepoContext } from "./context.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
const readyStates = ["ready", "deleted", "unavailable"] as HandleState[]
const badStates = ["deleted"] as HandleState[]

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
): Accessor<DocHandle<T> | undefined> {
  const contextRepo = useContext(RepoContext)

  if (!options?.repo && !contextRepo) {
    throw new Error("use outside <RepoContext> requires options.repo")
  }

  const repo = (options?.repo || contextRepo)!

  const handle = createMemo(async function () {
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) {
      return undefined
    }
    try {
      const documentId = new URL(unwrappedURL).pathname as DocumentId
      const existingHandle = repo.handles[documentId]
      if (existingHandle?.isReady()) {
        return existingHandle as DocHandle<T>
      }
    } catch (error) {
      console.error("Error parsing URL:", error)
      return undefined
    }
    const handle = await repo.find<T>(unwrappedURL, {
      allowableStates: readyStates,
    })
    if (handle.isReady()) {
      return handle
    } else if (handle.inState(badStates)) {
      return undefined
    } else {
      try {
        await handle.whenReady(readyStates)
        if (handle.isReady()) {
          return handle
        }
      } catch (error) {
        throw new Error("Error waiting for handle to be ready:", {
          cause: error,
        })
      }
    }
  })

  return handle
}
