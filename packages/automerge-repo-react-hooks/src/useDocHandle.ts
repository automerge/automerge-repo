import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
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

interface UseDocHandleSuspendingParams {
  suspense: true
}
interface UseDocHandleSynchronousParams {
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
  const controllerRef = useRef<AbortController>()
  const [handle, setHandle] = useState<DocHandle<T> | undefined>()

  let currentHandle: DocHandle<T> | undefined = handle
  if (id && !currentHandle) {
    // if we haven't saved a handle yet, check if one is immediately available
    const progress = repo.findWithProgress<T>(id)
    if (progress.state === "ready") {
      currentHandle = progress.handle
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
    if (suspense || !wrapper) {
      return
    }
    wrapper.promise
      .then(handle => {
        setHandle(handle as DocHandle<T>)
      })
      .catch(() => {
        setHandle(undefined)
      })
  }, [suspense, wrapper])

  if (currentHandle || !suspense || !wrapper) {
    return currentHandle
  }

  return wrapper.read() as DocHandle<T>
}
