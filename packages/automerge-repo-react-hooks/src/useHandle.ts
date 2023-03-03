import { DocHandle, DocumentId } from "automerge-repo"
import { useState } from "react"
import { useRepo } from "./useRepo"

export function useHandle<T>(documentId: DocumentId): DocHandle<T> {
  const repo = useRepo()
  const [handle] = useState<DocHandle<T>>(repo.find(documentId))
  return handle
}
