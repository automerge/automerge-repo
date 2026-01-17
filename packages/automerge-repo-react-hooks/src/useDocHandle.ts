import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"
import { anyDocumentIdToAutomergeUrl } from "../../automerge-repo/dist/AutomergeUrl.js"

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

  const expectedUrl = id ? anyDocumentIdToAutomergeUrl(id) : undefined
  let currentHandle: DocHandle<T> | undefined =
    // make sure the handle matches the id
    id && handle && handle.url === expectedUrl
      ? handle
      : undefined

  if (id && handle && !currentHandle) {
    console.log(`[useDocHandle] URL mismatch! id=${id}, handle.url=${handle.url}, expectedUrl=${expectedUrl}`)
  }

  if (id && !currentHandle) {
    // if we haven't saved a handle yet, check if one is immediately available
    const progress = repo.findWithProgress<T>(id)
    if (progress.state === "ready") {
      currentHandle = progress.handle
      console.log(`[useDocHandle] got handle from findWithProgress for ${id?.toString().slice(0, 20)}`)
    }
  }

  let wrapper = id ? wrapperCache.get(id) : undefined
  if (!wrapper && id) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    console.log(`[useDocHandle] creating wrapper for ${id?.toString().slice(0, 20)}`)
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
    console.log(`[useDocHandle] setting up promise handler for ${id?.toString().slice(0, 20)}`)
    wrapper.promise
      .then(handle => {
        console.log(`[useDocHandle] promise resolved for ${id?.toString().slice(0, 20)}, handle.url=${handle.url}, state=${handle.state}`)
        setHandle(handle as DocHandle<T>)
      })
      .catch((err) => {
        console.log(`[useDocHandle] promise rejected for ${id?.toString().slice(0, 20)}:`, err)
        // Clear the wrapper cache so we can retry when the document becomes available
        if (id) {
          wrapperCache.delete(id)
        }
        setHandle(undefined)
      })
  }, [currentHandle, suspense, wrapper])

  // Listen for the document becoming available after initial unavailability
  // This handles the case where the document data arrives after we first tried to load it
  useEffect(() => {
    if (!id || currentHandle) {
      return
    }

    const onDocument = ({ handle: newHandle }: { handle: DocHandle<unknown> }) => {
      if (newHandle.url === expectedUrl && newHandle.isReady()) {
        console.log(`[useDocHandle] document event: ${id?.toString().slice(0, 20)} is now ready`)
        setHandle(newHandle as DocHandle<T>)
      }
    }

    console.log(`[useDocHandle] listening for document event for ${id?.toString().slice(0, 20)}`)
    repo.on("document", onDocument)

    // Also check if the handle is now ready (in case we missed the event)
    const progress = repo.findWithProgress<T>(id)
    if (progress.state === "ready" && progress.handle.isReady()) {
      console.log(`[useDocHandle] handle became ready while setting up listener for ${id?.toString().slice(0, 20)}`)
      setHandle(progress.handle)
    }

    return () => {
      repo.off("document", onDocument)
    }
  }, [id, currentHandle, expectedUrl, repo])

  if (currentHandle || !suspense || !wrapper) {
    return currentHandle
  }

  return wrapper.read() as DocHandle<T>
}
