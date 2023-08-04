import { Doc, ChangeFn, ChangeOptions } from "@automerge/automerge"
import { DocumentId, DocHandleChangePayload } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo"

export function useDocument<T>(documentId?: DocumentId) {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = documentId ? repo.find<T>(documentId) : null

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

  return [doc, changeDoc] as [Doc<T>, (changeFn: ChangeFn<T>) => void]
}
