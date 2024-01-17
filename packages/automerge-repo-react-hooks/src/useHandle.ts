import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

/** A hook which returns a {@link DocHandle} identified by a URL.
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 */
export function useHandle<T>(id?: AnyDocumentId): DocHandle<T> | undefined {
  const repo = useRepo()
  const [handle, setHandle] = useState<DocHandle<T>>(
    id ? repo.find(id) : undefined
  )

  useEffect(() => {
    setHandle(id ? repo.find(id) : undefined)
  }, [id])

  return handle
}
