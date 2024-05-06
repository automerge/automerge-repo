import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"
import { interpretAsDocumentId } from "@automerge/automerge-repo/dist/AutomergeUrl.js"

/** A hook which returns a {@link DocHandle} identified by a URL.
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 */
export function useHandle<T>(id?: AnyDocumentId) {
  const repo = useRepo()
  const [handle, setHandle] = useState<DocHandle<T> | undefined>(
    id ? repo.find(id) : undefined
  )

  useEffect(() => {
    setHandle(id ? repo.find(id) : undefined)
  }, [id])

  if (
    !id ||
    !handle ||
    // Don't return a handle if it doesn't match the currently passed-in ID
    interpretAsDocumentId(handle.url) !== interpretAsDocumentId(id)
  ) {
    return undefined
  }

  return handle
}
