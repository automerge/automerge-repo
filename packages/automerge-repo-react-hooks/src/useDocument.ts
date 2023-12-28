import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/next"
import { AutomergeUrl, DocHandleChangePayload } from "@automerge/automerge-repo"
import { useEffect, useRef, useState } from "react"
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
  documentUrl?: AutomergeUrl
): [Doc<T> | undefined, (changeFn: ChangeFn<T>) => void] {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = documentUrl ? repo.find<T>(documentUrl) : null
  const handleRef = useRef(null)

  useEffect(() => {
    // When the handle has changed, reset the doc to an empty state.
    // This ensures that if loading the doc takes a long time, the UI
    // shows a loading state during that time rather than a stale doc.
    setDoc(undefined)

    if (!handle) {
      return
    }

    handleRef.current = handle
    handle
      .doc()
      .then(v => {
        // Bail out on updating the doc if the handle has changed since we started loading.
        // This avoids problem with out-of-order loads when the handle is changing faster
        // than documents are loading.
        if (handleRef.current !== handle) {
          return
        }
        setDoc(v)
      })
      .catch(e => console.error(e))

    const onChange = (h: DocHandleChangePayload<T>) => setDoc(h.doc)
    handle.on("change", onChange)
    const cleanup = () => {
      handle.removeListener("change", onChange)
    }

    return cleanup
  }, [handle])

  const changeDoc = (
    changeFn: ChangeFn<T>,
    options?: ChangeOptions<T> | undefined
  ) => {
    if (!handle) return
    handle.change(changeFn, options)
  }

  return [doc, changeDoc]
}
