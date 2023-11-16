import {
  AnyDocumentId,
  DocHandleChangePayload,
} from "@automerge/automerge-repo"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/next"
import { useEffect, useState } from "react"
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
): [Doc<T> | undefined, (changeFn: ChangeFn<T>) => void] {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = id ? repo.find<T>(id) : null

  useEffect(() => {
    if (!handle) return

    handle.doc().then(v => setDoc(v))

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
