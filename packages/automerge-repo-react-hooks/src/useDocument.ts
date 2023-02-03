import { ChangeFn, Doc } from "@automerge/automerge"
import { DocHandleChangePayload, DocumentId } from "automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

export function useDocument<T>(documentId?: DocumentId) {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = documentId ? repo.find<T>(documentId) : null

  useEffect(() => {
    if (!handle) return

    handle.value().then(v => setDoc(v))

    const onChange = (h: DocHandleChangePayload<T>) => setDoc(h.handle.doc)
    handle.on("change", onChange)
    const cleanup = () => {
      handle.removeListener("change", onChange)
    }

    return cleanup
  }, [handle])

  const changeDoc = (changeFn: ChangeFn<T>) => {
    if (!handle) return
    handle.change(changeFn)
  }

  return [doc, changeDoc] as [Doc<T>, (changeFn: ChangeFn<T>) => void]
}
