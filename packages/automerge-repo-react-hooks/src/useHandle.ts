import { AnyDocumentId, DocHandle } from "@automerge/automerge-repo/slim"
import { useRepo } from "./useRepo.js"

/** A hook which returns a {@link DocHandle} identified by a URL.
 *
 * @remarks
 * This requires a {@link RepoContext} to be provided by a parent component.
 */
export function useHandle<T>(id?: AnyDocumentId): DocHandle<T> | undefined {
  const repo = useRepo()
  return id ? repo.find(id) : undefined
}
