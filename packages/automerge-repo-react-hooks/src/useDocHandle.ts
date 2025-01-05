import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef } from "react"

const handleCache = new Map<AnyDocumentId, WeakRef<DocHandle<any>>>()
const promiseCache = new Map<AnyDocumentId, Promise<DocHandle<any>>>()

export function useDocHandle<T>(id: AnyDocumentId): DocHandle<T> {
  const repo = useRepo()
  const controllerRef = useRef<AbortController>()

  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      promiseCache.delete(id)
    }
  }, [id])

  // Return cached handle if we have it and it's still alive
  const cachedRef = handleCache.get(id)
  if (cachedRef) {
    const handle = cachedRef.deref() as DocHandle<T> | undefined
    if (handle) {
      return handle
    }
    // Handle was GC'd, remove the dead WeakRef
    handleCache.delete(id)
  }

  // Return cached promise if we have one in flight
  let promise = promiseCache.get(id) as Promise<DocHandle<T>>
  if (!promise) {
    // Start new request
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    promise = repo
      .find<T>(id, { signal: controllerRef.current.signal })
      .then(handle => {
        handleCache.set(id, new WeakRef(handle))
        promiseCache.delete(id)
        return handle
      })
    promiseCache.set(id, promise)
  }

  throw promise
}
