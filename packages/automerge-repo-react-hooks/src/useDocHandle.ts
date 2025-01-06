import type { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef } from "react"

const handleCache = new Map<AnyDocumentId, WeakRef<DocHandle<any>>>()
const wrapperCache = new Map<AnyDocumentId, ReturnType<typeof wrapPromise>>()

export function useDocHandle<T>(id: AnyDocumentId): DocHandle<T> {
  const repo = useRepo()
  const controllerRef = useRef<AbortController>()

  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      wrapperCache.delete(id)
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

  // Return cached wrapper if we have one in flight
  let wrapper = wrapperCache.get(id)
  if (!wrapper) {
    // Start new request
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo
      .find<T>(id, { signal: controllerRef.current.signal })
      .then(handle => {
        handleCache.set(id, new WeakRef(handle))
        wrapperCache.delete(id)
        return handle
      })

    wrapper = wrapPromise(promise)
    wrapperCache.set(id, wrapper)
  }

  // TODO: Why do I need this cast?
  return wrapper.read() as DocHandle<T>
}
