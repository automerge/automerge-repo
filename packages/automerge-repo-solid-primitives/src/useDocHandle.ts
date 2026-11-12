import type {
  AsHandle,
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim"
import {
  createEffect,
  createResource,
  useContext,
  type Resource,
} from "solid-js"
import { RepoContext } from "./context.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
import type { RegisteredRepo } from "./useRepo.js"

/**
 * get a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 * from an
 * [AutomergeUrl](https://automerge.org/automerge-repo/types/_automerge_automerge_repo.AutomergeUrl.html)
 * as a
 * [Resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).
 * Waits for the handle to be ready. Takes the document type
 * (`useDocHandle<Todo>`) or a handle type (`useDocHandle<AppHandle<Todo>>`,
 * with `type AppHandle<T> = HandleOf<typeof repo, T>`) to be typed with the
 * features the Repo's backend adds; both assert what the Repo is.
 * {@link createRepoPrimitives} checks it.
 */
export default function useDocHandle<X>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): Resource<AsHandle<X, RegisteredRepo> | undefined> {
  return useDocHandleIn(repoFor(options), url, options) as Resource<
    AsHandle<X, RegisteredRepo> | undefined
  >
}

/** @internal `options.repo`, else the one in {@link RepoContext}. */
export function repoFor(options?: UseDocHandleOptions): Repo {
  const contextRepo = useContext(RepoContext)
  if (!options?.repo && !contextRepo) {
    throw new Error("use outside <RepoContext> requires options.repo")
  }
  return (options?.repo || contextRepo)!
}

/** @internal {@link useDocHandle} on a given Repo. */
export function useDocHandleIn<T>(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<UseDocHandleOptions, "~skipInitialValue">
): Resource<DocHandle<T> | undefined> {
  function getExistingHandle() {
    if (options?.["~skipInitialValue"]) return undefined
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) return undefined
    // Preserve synchronous initial values; find() resolves asynchronously.
    const state = repo.query<T>(unwrappedURL).state()
    return state.status === "ready" ? state.handle : undefined
  }

  const [handle, { mutate }] = createResource(url, url => repo.find<T>(url), {
    initialValue: getExistingHandle(),
  })

  createEffect(() => {
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) {
      mutate()
    }
  })

  return handle
}
