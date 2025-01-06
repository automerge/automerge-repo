import { useEffect, useRef } from "react"
import type { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim"
import { useRepo } from "./useRepo.js"

export function useDocHandles<T>(
  urls: AutomergeUrl[] = []
): Record<AutomergeUrl, DocHandle<T>> {
  const repo = useRepo()
  // Keep a mutable record of handles
  const handlesRef = useRef<Record<AutomergeUrl, DocHandle<T>>>({})

  useEffect(() => {
    // We'll abort any in-flight fetches if this effect is re-run or unmounts
    const controller = new AbortController()
    let cancelled = false

    async function syncHandles() {
      // Make a copy so we can manipulate
      const nextHandles = { ...handlesRef.current }

      // 1. For each URL, fetch a handle if it doesn't exist
      for (const url of urls) {
        if (!nextHandles[url]) {
          try {
            const handle = await repo.find<T>(url, {
              signal: controller.signal,
            })
            if (cancelled) return
            nextHandles[url] = handle
          } catch (err) {
            if (controller.signal.aborted) {
              // We were aborted; just stop
              return
            }
            console.error("Failed to load doc handle", url, err)
          }
        }
      }

      // 2. Remove handles for any URL no longer in the list
      for (const oldUrl of Object.keys(nextHandles)) {
        if (!urls.includes(oldUrl as AutomergeUrl)) {
          delete nextHandles[oldUrl as AutomergeUrl]
        }
      }

      // 3. Update the ref
      if (!cancelled) {
        handlesRef.current = nextHandles
      }
    }

    void syncHandles()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [repo, urls])

  // On every render, return the current map of handles
  return handlesRef.current
}
