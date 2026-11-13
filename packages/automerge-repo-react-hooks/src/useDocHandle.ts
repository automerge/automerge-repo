import {
  AnyDocumentId,
  DocHandle,
  Repo,
  type AsHandle,
  isValidAutomergeUrl,
  interpretAsDocumentId,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"

// Shared with useDocHandles
export const wrapperCache = new Map<
  AnyDocumentId,
  PromiseWrapper<DocHandle<unknown>>
>()
// NB: this is a global cache that isn't keyed on the Repo
//     so if your app uses the same documents in two Repos
//     this could cause problems. please let me know if you do.

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
 * The handle for a document, from the Repo in {@link RepoContext}. Takes the
 * document type (`useDocHandle<Todo>`) or a handle type
 * (`useDocHandle<AppHandle<Todo>>`, with
 * `type AppHandle<T> = HandleOf<typeof repo, T>`) to be typed with the
 * features the Repo's backend adds. Both assert what the Repo in context
 * is; {@link createRepoHooks} checks it.
 */
export function useDocHandle<X>(
  id: AnyDocumentId,
  params: UseDocHandleSuspendingParams
): AsHandle<X>
export function useDocHandle<X>(
  id: AnyDocumentId | undefined,
  params?: UseDocHandleSynchronousParams
): AsHandle<X> | undefined
export function useDocHandle<X>(
  id: AnyDocumentId | undefined,
  params?: UseDocHandleParams
): AsHandle<X> | undefined {
  return useDocHandleIn(useRepo(), id, params) as AsHandle<X> | undefined
}

/** @internal {@link useDocHandle} on a given Repo. */
export function useDocHandleIn<T>(
  repo: Repo,
  id: AnyDocumentId | undefined,
  { suspense }: UseDocHandleParams = { suspense: false }
): DocHandle<T> | undefined {
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const [handle, setHandle] = useState<DocHandle<T> | undefined>()

  let currentHandle: DocHandle<T> | undefined =
    // make sure the handle matches the id
    id &&
    handle &&
    handle.url ===
      // Normalized, as handle.url is (e.g. a long ID's short form).
      stringifyAutomergeUrl(
        isValidAutomergeUrl(id)
          ? parseAutomergeUrl(id)
          : { documentId: interpretAsDocumentId(id) }
      )
      ? handle
      : undefined

  if (id && !currentHandle) {
    // Preserve synchronous initial values; find() resolves asynchronously.
    const state = repo.query<T>(id).state()
    if (state.status === "ready") {
      currentHandle = state.handle
    }
  }

  let wrapper = id ? wrapperCache.get(id) : undefined
  if (!wrapper && id) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find<T>(id, { signal: controllerRef.current.signal })
    wrapper = wrapPromise(promise)
    wrapperCache.set(id, wrapper)
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
        if (active) setHandle(handle as DocHandle<T>)
      })
      .catch(() => {
        // Drop the failed wrapper so a later render retries instead of reusing
        // the rejection.
        if (id && wrapperCache.get(id) === wrapper) {
          wrapperCache.delete(id)
        }
        if (active) setHandle(undefined)
      })
    return () => {
      active = false
    }
  }, [currentHandle, suspense, wrapper, id])

  if (currentHandle || !suspense || !wrapper) {
    return currentHandle
  }

  return wrapper.read() as DocHandle<T>
}
