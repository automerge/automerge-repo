import { Doc, ChangeFn } from "@automerge/automerge"
import { DocumentId, DocHandlePatchPayload } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo"

export function useDocument<T>(documentId?: DocumentId) {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = documentId ? repo.find<T>(documentId) : null

  useEffect(() => {
    if (!handle) return

    handle.value().then(v => setDoc(v))

    const onPatch = (h: DocHandlePatchPayload<T>) => setDoc(h.patchInfo.after)
    handle.on("patch", onPatch)
    const cleanup = () => {
      handle.removeListener("patch", onPatch)
    }

    return cleanup
  }, [handle])

  const changeDoc = (changeFn: ChangeFn<T>) => {
    if (!handle) return
    handle.change(changeFn)
  }

  return [doc, changeDoc] as [Doc<T>, (changeFn: ChangeFn<T>) => void]
}
