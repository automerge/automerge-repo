import { Doc } from "@automerge/automerge"
import {
  DocHandle,
  DocumentId,
  DocHandleChangeEvent,
  Repo,
} from "automerge-repo"
import { useEffect, useState, createContext, useContext } from "react"

export const RepoContext = createContext<Repo | null>(null)

export function useRepo(): Repo {
  const repo = useContext(RepoContext)

  if (!repo) {
    throw new Error("Repo not available on RepoContext.")
  }

  return repo
}

export function useHandle<T>(documentId: DocumentId): DocHandle<T> {
  const repo = useRepo()
  const [handle] = useState<DocHandle<T>>(repo.find(documentId))
  return handle
}

export type Change<T> = (cf: (d: T) => void) => void

export function useDocument<T>(
  documentId?: DocumentId
): [doc: Doc<T> | undefined, changeFn: Change<T>] {
  const [doc, setDoc] = useState<Doc<T>>()
  const repo = useRepo()
  const handle = documentId ? repo.find<T>(documentId) : null

  useEffect(() => {
    if (!handle) {
      return
    }
    handle.value().then((v) => setDoc(v as Doc<T>))
    const listener = (h: DocHandleChangeEvent<T>) =>
      setDoc(h.handle.doc as Doc<T>) // TODO: this is kinda gross
    handle.on("change", listener)

    return () => {
      handle.removeListener("change", listener)
    }
  }, [handle])

  const changeDoc = (changeFunction: (d: T) => void) => {
    if (!handle) {
      return
    }
    handle.change(changeFunction)
  }

  return [doc, changeDoc]
}
