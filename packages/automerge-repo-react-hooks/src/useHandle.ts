import { DocHandle, DocumentId } from "@automerge/automerge-repo"
import { useState } from "react"
import { useRepo } from "./useRepo.js"

export function useHandle<T>(documentId: DocumentId): DocHandle<T> {
  const repo = useRepo()
  const [handle] = useState<DocHandle<T>>(repo.find(documentId))
  return handle
}
