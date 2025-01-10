import {
  AnyDocumentId,
  compute,
  DocHandle,
  Signal,
} from "@automerge/automerge-repo/slim"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"
import { abortable } from "@automerge/automerge-repo/helpers/abortable.js"
import { FindProgress } from "../../automerge-repo/dist/FindProgress.js"

// Shared with useDocHandles
export const promiseCache = new Map<
  AnyDocumentId,
  PromiseWrapper<DocHandle<unknown>>
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
  const progSig = repo.findWithSignalProgress<T>(id)
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
  let wrapper = promiseCache.get(id) as PromiseWrapper<DocHandle<T>> | undefined
  if (!wrapper) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = handlePromise<T>(progSig, id)
    const abortPromise = abortable(controllerRef.current?.signal)
    wrapper = wrapPromise(Promise.race([promise, abortPromise]))

    promiseCache.set(id, wrapper as any)
  }

  return wrapper.read()
}

function handlePromise<T>(
  progSig: Signal<FindProgress<T>>,
  id: AnyDocumentId
): Promise<DocHandle<T>> {
  return new Promise<DocHandle<T>>((resolve, reject) => {
    compute(get => {
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
  })
}
