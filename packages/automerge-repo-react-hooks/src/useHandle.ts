import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo"
import { useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a {@link DocHandle} identified by a URL.
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 */
export function useHandle<T>(automergeUrl: AutomergeUrl): DocHandle<T> {
  const repo = useRepo()
  const [handle] = useState<DocHandle<T>>(repo.find(automergeUrl))
  return handle
}
