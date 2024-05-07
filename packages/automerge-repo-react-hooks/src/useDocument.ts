import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/next"
import { useCallback, useEffect, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a document identified by a URL and a function to change the document.
 *
 * @returns a tuple of the document and a function to change the document.
 * The document will be `undefined` if the document is not available in storage or from any peers
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 * */
export function useDocument<T>(
  id?: AnyDocumentId
): [
  Doc<T> | undefined,
  (changeFn: ChangeFn<T>, options?: ChangeOptions<T> | undefined) => void
] {
  const repo = useRepo()
  const handle = id ? repo.find<T>(id) : null
  const handleRef = useRef<DocHandle<T> | null>(handle)
  if (handle !== handleRef.current) {
    handleRef.current = handle
  }

  // a state value we use to trigger a re-render
  const [, setGeneration] = useState(0)
  const rerender = () => setGeneration(v => v + 1)

  useEffect(() => {
    if (!id || !handle) {
      return
    }

    // When the handle has changed, reset the doc to the current value of docSync().
    // For already-loaded documents this will be the last known value, for unloaded documents
    // this will be undefined.
    // This ensures that if loading the doc takes a long time, the UI
    // shows a loading state during that time rather than a stale doc.

    handleRef.current = handle
    handle
      .doc()
      .then(() => {
        rerender()
      })
      .catch(e => console.error(e))

    handle.on("change", rerender)
    handle.on("delete", rerender)
    const cleanup = () => {
      handle.removeListener("change", rerender)
      handle.removeListener("delete", rerender)
    }

    return cleanup
  }, [id, handle])

  const changeDoc = useCallback(
    (changeFn: ChangeFn<T>, options?: ChangeOptions<T> | undefined) => {
      if (!handle) return
      handle.change(changeFn, options)
    },
    [handle]
  )

  return [handle?.docSync(), changeDoc] as const
}
