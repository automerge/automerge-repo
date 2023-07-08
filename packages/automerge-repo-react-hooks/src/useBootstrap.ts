import { DocHandle, DocumentId, Repo } from "@automerge/automerge-repo"
import { useEffect, useState, useMemo } from "react"
import { useRepo } from "./useRepo.js"

// Set URL hash
export const setHash = (hash: string, pushState = false) => {
  // Update URL hash
  history[pushState ? "pushState" : "replaceState"]("", "", "#" + hash)
  // Send fake hashchange event
  window.dispatchEvent(
    new HashChangeEvent("hashchange", {
      newURL: window.location.origin + window.location.pathname + hash,
      oldURL: window.location.href,
    })
  )
}

// Get current URL hash
export const useHash = () => {
  const [hashValue, setHashValue] = useState(window.location.hash)
  useEffect(() => {
    const handler = () => void setHashValue(window.location.hash)
    window.addEventListener("hashchange", handler)
    return () => void window.removeEventListener("hashchange", handler)
  }, [])
  return hashValue
}

// Get a key from a query-param-style URL hash
const getQueryParamValue = (key: string, hash) =>
  new URLSearchParams(hash.substr(1)).get(key)

const setQueryParamValue = (key: string, value, hash): string => {
  const u = new URLSearchParams(hash.substr(1))
  u.set(key, value)
  return u.toString()
}

const getDocumentId = (key, hash) =>
  key && (getQueryParamValue(key, hash) || localStorage.getItem(key))

const setDocumentId = (key, documentId) => {
  if (key) {
    // Only set URL hash if document ID changed
    if (documentId !== getQueryParamValue(key, window.location.hash))
      setHash(setQueryParamValue(key, documentId, window.location.hash))
  }
  if (key) localStorage.setItem(key, documentId)
}

/**
 * This hook is used to set up a single document as the base of an app session.
 * This is a common pattern for simple multiplayer apps with shareable URLs.
 *
 * It will first check for the document ID in the URL hash:
 *   //myapp/#documentId=[document ID]
 * Failing that, it will check for a `documentId` key in localStorage.
 * Failing that, it will call onNoDocument, expecting a handle to be returned.
 *
 * The URL and localStorage will then be updated.
 * Finally, it will return the document ID.
 *
 * @param {string?} props.key Key to use for the URL hash and localStorage
 * @param {function?} props.fallback Function returning a document handle called if lookup fails. Defaults to repo.create()
 * @param {function?} props.onInvalidDocumentId Function to call if documentId is invalid; signature (error) => (repo, onCreate)
 * @returns {DocHandle} The document handle
 */
interface UseBootstrapOptions<T> {
  key?: string
  onNoDocument?: (repo: Repo) => DocHandle<T>
  onInvalidDocumentId?(repo: Repo, error: Error): DocHandle<T>
}

export const useBootstrap = <T>({
  key = "documentId",
  onNoDocument = repo => repo.create(),
  onInvalidDocumentId,
}: UseBootstrapOptions<T> = {}): DocHandle<T> => {
  const repo = useRepo()
  const hash = useHash()

  // Try to get existing document; else create a new one
  const handle = useMemo((): DocHandle<T> => {
    const existingDocumentId = getDocumentId(key, hash)
    try {
      return existingDocumentId
        ? repo.find(existingDocumentId as DocumentId)
        : onNoDocument(repo)
    } catch (error) {
      // Presumably the documentId was invalid
      if (existingDocumentId && onInvalidDocumentId)
        return onInvalidDocumentId(repo, error)
      // Forward other errors
      throw error
    }
  }, [hash, repo, onNoDocument, onInvalidDocumentId])

  // Update hashroute & localStorage on changes
  useEffect(() => {
    if (handle) {
      setDocumentId(key, handle.documentId)
    }
  }, [hash, handle])

  return handle
}
