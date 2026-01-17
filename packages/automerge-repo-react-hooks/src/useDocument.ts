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
    setDoc(handle?.doc())
  }, [handle])

  useEffect(() => {
    if (!handle) {
      return
    }
    const onChange = () => setDoc(handle.doc())
    const onDelete = () => {
      setDeleteError(new Error(`Document ${id} was deleted`))
    }

    handle.on("change", onChange)
    handle.on("delete", onDelete)

    return () => {
      handle.removeListener("change", onChange)
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
