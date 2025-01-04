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
export function useDocument<T>(
  id: AnyDocumentId
): [Doc<T>, (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => void] {
  const handle = useDocHandle<T>(id)
  const [doc, setDoc] = useState<Doc<T>>()

  useEffect(() => {
    setDoc(handle.docSync())

    const onChange = () => setDoc(handle.docSync())
    const onDelete = () => {
      throw new Error(`Document ${id} was deleted`)
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
      handle.change(changeFn, options)
    },
    [handle]
  )

  // TODO: this exclamation point is because docSync() needs its type signature updated
  return [doc!, changeDoc]
}
