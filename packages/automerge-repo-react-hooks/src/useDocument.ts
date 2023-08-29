import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/next"
import { AutomergeUrl, DocHandleChangePayload } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

export function useDocument<T>(documentUrl?: AutomergeUrl) {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()

  const handle = documentUrl ? repo.find<T>(documentUrl) : null

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
