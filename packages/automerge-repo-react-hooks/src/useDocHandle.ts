import type { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useRef } from "react"

const wrapperCache = new Map<AnyDocumentId, ReturnType<typeof wrapPromise>>()

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

  let wrapper = wrapperCache.get(id)
  if (!wrapper) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find<T>(id, { signal: controllerRef.current.signal })
    wrapper = wrapPromise(promise)
    wrapperCache.set(id, wrapper)
  }

  if (suspense === false) {
    try {
      return wrapper.read() as DocHandle<T>
    } catch (e) {
      if (e instanceof Promise) {
        return undefined
      }
      throw e
    }
  }

  return wrapper.read() as DocHandle<T>
}
