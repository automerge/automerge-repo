import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"

// Shared with useDocHandles
export const wrapperCache = new Map<
  AnyDocumentId,
  ReturnType<typeof wrapPromise>
>()

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
  id: AnyDocumentId,
  params?: UseDocHandleSynchronousParams
): DocHandle<T> | undefined
export function useDocHandle<T>(
  id: AnyDocumentId,
  { suspense }: UseDocHandleParams = { suspense: false }
): DocHandle<T> | undefined {
  const repo = useRepo()
  const controllerRef = useRef<AbortController>()
  const [handle, setHandle] = useState<DocHandle<T> | undefined>()

  let wrapper = wrapperCache.get(id)
  if (!wrapper) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find<T>(id, { signal: controllerRef.current.signal })
    wrapper = wrapPromise(promise)
    wrapperCache.set(id, wrapper)
  }

  useEffect(() => {
    if (suspense === false) {
      void wrapper.promise
        .then(handle => {
          setHandle(handle as DocHandle<T>)
        })
        .catch(e => {
          console.log("handle promise caught", e)
          setHandle(undefined)
        })
    }
  }, [suspense, wrapper])

  if (suspense) {
    return wrapper.read() as DocHandle<T>
  } else {
    return handle || undefined
  }
}
