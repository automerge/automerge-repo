import { DocHandle, Repo, type AutomergeUrl } from "@automerge/automerge-repo"
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
const getQueryParamValue = (key: string, hash: string) =>
  new URLSearchParams(hash.substr(1)).get(key)

const setQueryParamValue = (key: string, value, hash): string => {
  const u = new URLSearchParams(hash.substr(1))
  u.set(key, value)
  return u.toString()
}

const getAutomergeUrl = (key: string, hash: string) =>
  key && (getQueryParamValue(key, hash) || localStorage.getItem(key))

const setAutomergeUrl = (key: string, automergeUrl: AutomergeUrl) => {
  if (key) {
    // Only set URL hash if automerge URL changed
    if (automergeUrl !== getQueryParamValue(key, window.location.hash))
      setHash(setQueryParamValue(key, automergeUrl, window.location.hash))
  }
  if (key) localStorage.setItem(key, automergeUrl)
}

export interface UseBootstrapOptions<T> {
  /** Key to use for the URL hash and localStorage */
  key?: string
  /** Function returning a document handle called if lookup fails. Defaults to repo.create() */
  onNoDocument?: (repo: Repo) => DocHandle<T>
}

/**
 * This hook is used to set up a single document as the base of an app session.
 * This is a common pattern for simple multiplayer apps with shareable URLs.
 *
 * It will first check for the automergeUrl in the URL hash:
 *   //myapp/#automergeUrl=[document URL]
 * Failing that, it will check for a `automergeUrl` key in localStorage.
 * Failing that, it will call onNoDocument, expecting a handle to be returned.
 *
 * The URL and localStorage will then be updated.
 * Finally, it will return the Automerge document's URL.
 *
 * @param {string?} props.key Key to use for the URL hash and localStorage
 * @param {function?} props.fallback Function returning a document handle called if lookup fails. Defaults to repo.create()
 * @returns {DocHandle} The document handle
 */
export const useBootstrap = <T>({
  key = "automergeUrl",
  onNoDocument = repo => repo.create(),
}: UseBootstrapOptions<T> = {}): DocHandle<T> => {
  const repo = useRepo()
  const hash = useHash()

  // Try to get existing document; else create a new one
  const handle = useMemo((): DocHandle<T> => {
    const url = getAutomergeUrl(key, hash) as AutomergeUrl | undefined
    return url ? repo.find(url) : onNoDocument(repo)
  }, [hash, repo, onNoDocument])

  // Update hashroute & localStorage on changes
  useEffect(() => {
    if (handle) {
      setAutomergeUrl(key, handle.url)
    }
  }, [hash, handle])

  return handle
}
