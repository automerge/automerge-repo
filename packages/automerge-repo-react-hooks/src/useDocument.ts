import { AnyDocumentId } from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim"
import { useCallback, useEffect, useState } from "react"
import { useDocHandle } from "./useDocHandle.js"

/**
 * A hook which returns a document and a function to change it.
 * Uses React Suspense for loading states, returning a tuple matching useState pattern.
 *
 * @example
 * ```tsx
 * function Counter() {
 *   const [doc, changeDoc] = useDocument<{ count: number }>(docUrl)
 *   return (
 *     <button onClick={() => changeDoc(d => d.count++)}>
 *       Count: {doc.count}
 *     </button>
 *   )
 * }
 *
 * // Must be wrapped in Suspense boundary
 * <Suspense fallback={<Loading />}>
 *   <Counter />
 * </Suspense>
 * ```
 */

interface UseDocumentSuspendingParams {
  suspense: true
}
interface UseDocumentSynchronousParams {
  suspense: false
}

type UseDocumentParams =
  | UseDocumentSuspendingParams
  | UseDocumentSynchronousParams

export type UseDocumentReturn<T> = [
  Doc<T>,
  (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => void
]

export function useDocument<T>(
  id: AnyDocumentId,
  params: UseDocumentSuspendingParams
): UseDocumentReturn<T>
export function useDocument<T>(
  id: AnyDocumentId | undefined,
  params?: UseDocumentSynchronousParams
): UseDocumentReturn<T> | [undefined, () => void]
export function useDocument<T>(
  id: AnyDocumentId | undefined,
  params: UseDocumentParams = { suspense: false }
): UseDocumentReturn<T> | [undefined, () => void] {
  // @ts-expect-error -- typescript doesn't realize we're discriminating these types the same way in both functions
  const handle = useDocHandle<T>(id, params)
  // Initialize with current doc state
  const [doc, setDoc] = useState<Doc<T> | undefined>(() => handle?.doc())
  const [deleteError, setDeleteError] = useState<Error>()

  // Reinitialize doc when handle changes
  useEffect(() => {
    // Only update doc if handle is ready - otherwise keep current state
    // and wait for the change listener to update when handle becomes ready
    if (handle?.isReady()) {
      console.log(`[useDocument ${handle.documentId.slice(0, 8)}] handle ready, setting doc`)
      setDoc(handle.doc())
    } else if (handle) {
      console.log(`[useDocument ${handle.documentId.slice(0, 8)}] handle not ready (state: ${handle.state}), waiting for change event`)
    }
  }, [handle])

  useEffect(() => {
    if (!handle) {
      return
    }
    const onChange = () => {
      const newDoc = handle.doc()
      const isSameRef = newDoc === doc
      console.log(`[useDocument ${handle.documentId.slice(0, 8)}] onChange callback fired, calling setDoc. isSameRef=${isSameRef}, doc keys:`, newDoc ? Object.keys(newDoc) : 'undefined')
      setDoc(newDoc)
    }
    const onHeadsChanged = () => {
      // Also listen for heads-changed in case the document becomes ready
      // but with patches.length=0 (which doesn't emit "change")
      if (handle.isReady()) {
        console.log(`[useDocument ${handle.documentId.slice(0, 8)}] onHeadsChanged: handle is ready, syncing doc`)
        setDoc(handle.doc())
      }
    }
    const onDelete = () => {
      setDeleteError(new Error(`Document ${id} was deleted`))
    }

    console.log(`[useDocument ${handle.documentId.slice(0, 8)}] registering change listener`)
    handle.on("change", onChange)
    handle.on("heads-changed", onHeadsChanged)
    handle.on("delete", onDelete)

    // If handle is already ready when we set up the listener, sync the doc now
    // This handles the race where handle became ready before effect ran
    if (handle.isReady()) {
      console.log(`[useDocument ${handle.documentId.slice(0, 8)}] handle already ready on listener setup, syncing doc`)
      setDoc(handle.doc())
    }

    return () => {
      console.log(`[useDocument ${handle.documentId?.slice(0, 8)}] removing change listener`)
      handle.removeListener("change", onChange)
      handle.removeListener("heads-changed", onHeadsChanged)
      handle.removeListener("delete", onDelete)
    }
  }, [handle, id])

  const changeDoc = useCallback(
    (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => {
      handle!.change(changeFn, options)
    },
    [handle]
  )

  if (deleteError) {
    throw deleteError
  }

  if (!doc) {
    return [undefined, () => {}]
  }
  return [doc, changeDoc]
}
