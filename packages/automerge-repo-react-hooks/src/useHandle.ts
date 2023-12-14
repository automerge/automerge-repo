import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a {@link DocHandle} identified by a URL.
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 */
export function useHandle<T>(docUrl?: AutomergeUrl): DocHandle<T> | undefined {
  const repo = useRepo()
  const [handle, setHandle] = useState<DocHandle<T>>(
    docUrl ? repo.find(docUrl) : undefined
  )

  useEffect(() => {
    setHandle(docUrl ? repo.find(docUrl) : undefined)
  }, [docUrl])

  return handle
}
