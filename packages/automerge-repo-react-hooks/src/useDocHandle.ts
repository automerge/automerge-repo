import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"

/**
 * A hook which manages a document handle. Uses React Suspense for loading states.
 */
export function useDocHandle<T>(id: AnyDocumentId): DocHandle<T> {
  const repo = useRepo()
  const [handle, setHandle] = useState<DocHandle<T>>()
  const controllerRef = useRef<AbortController>()

  if (!handle) {
    controllerRef.current = new AbortController()
    throw repo
      .find<T>(id, { signal: controllerRef.current.signal })
      .then(newHandle => {
        setHandle(newHandle)
        return newHandle
      })
  }

  useEffect(() => {
    return () => controllerRef.current?.abort()
  }, [])

  return handle
}
