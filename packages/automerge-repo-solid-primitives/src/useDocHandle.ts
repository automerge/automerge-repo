import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim"
import {
  createEffect,
  createResource,
  useContext,
  type Resource,
} from "solid-js"
import { RepoContext } from "./context.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"

/**
 * get a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 * from an
 * [AutomergeUrl](https://automerge.org/automerge-repo/types/_automerge_automerge_repo.AutomergeUrl.html)
 * as a
 * [Resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).
 * Waits for the handle to be ready.
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
    const state = repo.findWithProgress<T>(unwrappedURL).peek()
    return state.state === "ready" ? state.handle : undefined
  }

  const [handle, { mutate }] = createResource(
    url,
    url => repo.findWithProgress<T>(url).whenReady(),
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
