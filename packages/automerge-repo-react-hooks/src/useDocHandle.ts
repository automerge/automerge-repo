import {
  AnyDocumentId,
  DocHandle,
  interpretAsDocumentId,
} from "@automerge/automerge-repo/slim"
import { noop } from "@automerge/automerge-repo/helpers/noop.js"
import { WeakValueMap } from "@automerge/automerge-repo/helpers/WeakValueMap.js"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"
import { anyDocumentIdToAutomergeUrl } from "../../automerge-repo/dist/AutomergeUrl.js"

/**
 * Promise wrappers per document id: strong while the find() is in flight
 * (concurrent renders share one request), weak once settled. A settled
 * wrapper stays available for cache hits while something still references
 * it (React's pending suspense promise, a mounted component's state), and
 * releases its DocHandle for repo eviction once nothing does - a permanent
 * strong cache here would pin every document a hook ever resolved.
 */
class WrapperCache {
  #inFlight = new Map<string, PromiseWrapper<DocHandle<unknown>>>()
  #settled = new WeakValueMap<string, PromiseWrapper<DocHandle<unknown>>>()

  // WeakValueMap keys must be primitives. Every AnyDocumentId form is a
  // branded string except BinaryDocumentId, which is encoded to its
  // canonical DocumentId string. String forms key as themselves: a
  // heads-pinned url must not share an entry with its live document id.
  #key(id: AnyDocumentId): string {
    return typeof id === "string" ? id : interpretAsDocumentId(id)
  }

  get(id: AnyDocumentId): PromiseWrapper<DocHandle<unknown>> | undefined {
    const key = this.#key(id)
    return this.#inFlight.get(key) ?? this.#settled.get(key)
  }

  has(id: AnyDocumentId): boolean {
    return this.get(id) !== undefined
  }

  set(id: AnyDocumentId, wrapper: PromiseWrapper<DocHandle<unknown>>): void {
    const key = this.#key(id)
    this.#settled.delete(key)
    this.#inFlight.set(key, wrapper)
    void wrapper.promise.catch(noop).then(() => {
      if (this.#inFlight.get(key) === wrapper) {
        this.#inFlight.delete(key)
        this.#settled.set(key, wrapper)
      }
    })
  }

  delete(id: AnyDocumentId): void {
    const key = this.#key(id)
    this.#inFlight.delete(key)
    this.#settled.delete(key)
  }
}

// Shared with useDocHandles
export const wrapperCache = new WrapperCache()
// NB: this is a global cache that isn't keyed on the Repo
//     so if your app uses the same documents in two Repos
//     this could cause problems. please let me know if you do.

export interface UseDocHandleSuspendingParams {
  suspense: true
}
export interface UseDocHandleSynchronousParams {
  suspense: false
}

type UseDocHandleParams =
  | UseDocHandleSuspendingParams
  | UseDocHandleSynchronousParams

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
  { suspense }: UseDocHandleParams = { suspense: false }
): DocHandle<T> | undefined {
  const repo = useRepo()
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const [handle, setHandle] = useState<DocHandle<T> | undefined>()

  let currentHandle: DocHandle<T> | undefined =
    // make sure the handle matches the id
    id && handle && handle.url === anyDocumentIdToAutomergeUrl(id)
      ? handle
      : undefined

  if (id && !currentHandle) {
    // if we haven't saved a handle yet, check if one is immediately available
    const progress = repo.findWithProgress<T>(id)
    const state = progress.peek()
    if (state.state === "ready") {
      currentHandle = state.handle
    }
  }

  let wrapper = id
    ? (wrapperCache.get(id) as PromiseWrapper<DocHandle<T>> | undefined)
    : undefined
  if (!wrapper && id) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find<T>(id, { signal: controllerRef.current.signal })
    wrapper = wrapPromise(promise)
    wrapperCache.set(id, wrapper as PromiseWrapper<DocHandle<unknown>>)
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
