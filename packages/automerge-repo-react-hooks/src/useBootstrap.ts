/** Deprecated as of 1.1.6
 * scheduled removal in 2.0 (if it's 2.0 or great, get it out of here)
 * but you probably aren't using it anyway
 */

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
  new URLSearchParams(hash.slice(1)).get(key)

const setQueryParamValue = (
  key: string,
  value: string,
  hash: string
): string => {
  const u = new URLSearchParams(hash.slice(1))
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
  /** Function to call if automerge URL is invalid */
  onInvalidAutomergeUrl?(repo: Repo, error: Error): DocHandle<T>
}

/**
 * @deprecated Use the simpler example code in the README instead. 
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
 * @param {function?} props.onInvalidAutomergeUrl Function to call if URL is invalid; signature (error) => (repo, onCreate)
 * @returns {DocHandle} The document handle
 */
export const useBootstrap = <T>({
  key = "automergeUrl",
  onNoDocument = repo => repo.create(),
  onInvalidAutomergeUrl,
}: UseBootstrapOptions<T> = {}): DocHandle<T> => {
  const repo = useRepo()
  const hash = useHash()

  // Try to get existing document; else create a new one
  const handle = useMemo((): DocHandle<T> => {
    const url = getAutomergeUrl(key, hash) as AutomergeUrl | undefined
    try {
      return url ? repo.find(url) : onNoDocument(repo)
    } catch (error) {
      // Presumably the URL was invalid
      if (url && onInvalidAutomergeUrl)
        return onInvalidAutomergeUrl(repo, error as Error)
      // Forward other errors
      throw error
    }
  }, [hash, repo, onNoDocument, onInvalidAutomergeUrl])

  // Update hashroute & localStorage on changes
  useEffect(() => {
    if (handle) {
      setAutomergeUrl(key, handle.url)
    }
  }, [hash, handle])

  return handle
}
