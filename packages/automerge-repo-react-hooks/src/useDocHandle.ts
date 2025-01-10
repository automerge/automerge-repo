import {
  AnyDocumentId,
  compute,
  DocHandle,
} from "@automerge/automerge-repo/slim"
import { wrapPromise } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { useEffect, useRef, useState } from "react"

// Shared with useDocHandles
export const wrapperCache = new Map<
  AnyDocumentId,
  ReturnType<typeof wrapPromise>
>()

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
  params?: UseDocHandleSuspendingParams
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

  // Get current progress
  const val = repo.findWithSignalProgress(id).peek()

  // For ready state, we can return the handle immediately
  if (val.state === "ready") {
    return val.handle as DocHandle<T>
  }

  // For non-suspense mode, return previous handle or undefined
  if (!suspense) {
    console.log("non-suspense mode, returning undefined", val)
    return undefined
  }

  // If we're here, we're in suspense mode and not ready.
  // We'll create an abortable promise from the signal.
  let promise = promiseCache.get(id)
  if (!promise) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    promise = repo.find<T>(id, {
      abortSignal: controllerRef.current.signal,
    })
    promiseCache.set(id, promise)
  }
  throw promise
}
