import {
  AnyDocumentId,
  compute,
  DocHandle,
} from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"

// Shared with useDocHandles
export const promiseCache = new Map<
  AnyDocumentId,
  Promise<DocHandle<unknown>>
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
  options: UseDocHandleSuspendingParams
): DocHandle<T>
export function useDocHandle<T>(
  id: AnyDocumentId,
  { suspense }: UseDocHandleParams = { suspense: false }
): DocHandle<T> | undefined {
  const repo = useRepo()
  const controllerRef = useRef<AbortController>()

  // Cleanup effect for when id changes or component unmounts
  useEffect(() => {
    return () => {
      controllerRef.current?.abort()
      promiseCache.delete(id)
    }
  }, [id])

  // Get current progress
  const progSig = repo.findWithSignalProgress(id)
  const progress = progSig.peek()

  // For ready state, we can return the handle immediately
  if (progress.state === "ready") {
    return progress.handle as DocHandle<T>
  }

  // For non-suspense mode, return undefined
  if (!suspense) {
    return undefined
  }

  // If we're here, we're in suspense mode and not ready.
  let promise = promiseCache.get(id)
  if (!promise) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    promise = new Promise<DocHandle<T>>((resolve, reject) => {
      const computed = compute(get => {
        const prog = get(progSig)

        if (prog.state === "ready") {
          resolve(prog.handle as DocHandle<T>)
        } else if (prog.state === "failed") {
          reject(prog.error)
        } else if (prog.state === "unavailable") {
          reject(new Error(`Document ${id} is unavailable`))
        }

        return prog
      })

      controllerRef.current?.signal.addEventListener("abort", () => {
        reject(new Error("Operation aborted"))
      })
    })

    const cacheablePromise = wrapPromise(promise)

    promiseCache.set(id, cacheablePromise as any)
  }

  throw promise as Promise<DocHandle<T>>
}
