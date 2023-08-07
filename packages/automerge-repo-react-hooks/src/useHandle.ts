import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo"
import { useState } from "react"
import { useRepo } from "./useRepo.js"

export function useHandle<T>(automergeUrl: AutomergeUrl): DocHandle<T> {
  const repo = useRepo()
  const [handle] = useState<DocHandle<T>>(repo.find(automergeUrl))
  return handle
}
