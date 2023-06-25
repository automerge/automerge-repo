import { useRepo } from "automerge-repo-react-hooks"
import { DocumentId } from "automerge-repo"
import { useHash } from "react-use"

// Get a key from a query-param-style hash URL
const getHashValue = (key: string) => hash =>
  hash.match(new RegExp(`${key}=([^&]*)`))?.[1]

export const useDocumentId = (
  onCreate = s => s,
  getDocumentIdFromHash = getHashValue("id"),
  setDocumentIdFromHash = value => {
    window.location.hash = `#id=${value}`
  }
) => {
  const repo = useRepo()
  const [hash] = useHash()

  // Lookup existing document ID
  const idFromHash = getDocumentIdFromHash(hash)
  if (idFromHash) return idFromHash as DocumentId

  const handle = repo.create() // Create a new document
  handle.change(onCreate) // Set initial state
  setDocumentIdFromHash(handle.documentId) // Update hash
  return handle.documentId
}
