import { AnyDocumentId, DocHandle, Repo } from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { cacheKey, handleCache, normalizeId } from "./handleCache.js"
import { useEffect, useRef, useState } from "react"

export interface UseDocHandleSuspendingParams {
  suspense: true
}
export interface UseDocHandleSynchronousParams {
  suspense: false
}

export type UseDocHandleParams =
  | UseDocHandleSuspendingParams
  | UseDocHandleSynchronousParams

/**
 * The handle for a document, from the Repo in {@link RepoContext}. For
 * handles typed with the features the Repo's backend adds, use
 * {@link createRepoHooks}.
 */
export function useDocHandle<T>(
  id: AnyDocumentId,
  params: UseDocHandleSuspendingParams
): DocHandle<T>
export function useDocHandle<T>(
  id: AnyDocumentId | undefined,
  params?: UseDocHandleSynchronousParams
): DocHandle<T> | undefined
export function useDocHandle<T>(
  id: AnyDocumentId | undefined,
  params?: UseDocHandleParams
): DocHandle<T> | undefined {
  return useDocHandleIn<T>(useRepo(), id, params)
}

/** @internal {@link useDocHandle} on a given Repo. */
export function useDocHandleIn<T>(
  repo: Repo,
  id: AnyDocumentId | undefined,
  { suspense }: UseDocHandleParams = { suspense: false }
): DocHandle<T> | undefined {
  const controllerRef = useRef<AbortController | undefined>(undefined)
  // With the Repo it came from: a handle found on another Repo (the provided
  // one changed) is not this Repo's.
  const [found, setFound] = useState<
    { repo: Repo; handle: DocHandle<T> } | undefined
  >()
  const handle = found?.repo === repo ? found.handle : undefined

  let currentHandle: DocHandle<T> | undefined =
    // make sure the handle matches the id
    id && handle && handle.url === normalizeId(id) ? handle : undefined

  if (id && !currentHandle) {
    // Preserve synchronous initial values; find() resolves asynchronously.
    const state = repo.query<T>(id).state()
    if (state.status === "ready") {
      currentHandle = state.handle
    }
  }

  const cache = handleCache(repo)
  const key = id ? cacheKey(id) : undefined
  let wrapper = key ? cache.get(key) : undefined
  if (!wrapper && id && key) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find<T>(id, { signal: controllerRef.current.signal })
    wrapper = wrapPromise(promise)
    cache.set(key, wrapper)
  }

  /* From here we split into two paths: suspense and not.
   * In the suspense path, we return the wrapper directly.
   * In the non-suspense path, we wait for the promise to resolve
   * and then set the handle via setState. Suspense relies on
   * re-running this function until it succeeds, whereas the synchronous
   * form uses a setState to track the value. */
  useEffect(() => {
    if (currentHandle || suspense || !wrapper) {
      return
    }
    // Stays true until this effect run is torn down (unmount or id change); a
    // result that arrives after that must not setState for a stale id.
    let active = true
    wrapper.promise
      .then(handle => {
        if (active) setFound({ repo, handle: handle as DocHandle<T> })
      })
      .catch(() => {
        // Drop the failed wrapper so a later render retries instead of reusing
        // the rejection.
        if (key && cache.get(key) === wrapper) cache.delete(key)
        if (active) setFound(undefined)
      })
    return () => {
      active = false
    }
  }, [currentHandle, suspense, wrapper, key, cache, repo])

  if (currentHandle || !suspense || !wrapper) {
    return currentHandle
  }

  return wrapper.read() as DocHandle<T>
}
