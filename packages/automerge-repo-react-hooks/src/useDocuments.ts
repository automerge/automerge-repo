import {
  AutomergeUrl,
  DocHandleChangePayload,
  DocHandleDeletePayload,
} from "@automerge/automerge-repo/slim"
import { useEffect, useState } from "react"

/**
 * Maintains a map of document states, keyed by DocumentId. Useful for collections of related
 * documents.
 * Accepts either URLs or document IDs in the input array, but all get converted to IDs
 * for the output map.
 */
import { useDocHandles } from "./useDocHandles.js"

export function useDocuments<T>(
  urls: AutomergeUrl[] = []
): Record<AutomergeUrl, T> {
  // Get the doc handles from the other hook
  const handles = useDocHandles<T>(urls)
  // Maintain doc contents (the actual data)
  const [documents, setDocuments] = useState<Record<string, T>>({})

  // On mount (and whenever handles change), sync the initial doc states
  useEffect(() => {
    setDocuments(prev => {
      const updated = { ...prev }

      // For each handle we have, ensure there's an entry in `documents`
      for (const [url, handle] of Object.entries(handles)) {
        if (!updated[url]) {
          updated[url] = handle.docSync()
        }
      }
      // Remove entries for handles we no longer have
      for (const url of Object.keys(updated)) {
        if (!handles[url as AutomergeUrl]) {
          delete updated[url]
        }
      }
      return updated
    })
  }, [handles])

  // Attach 'change' and 'delete' listeners
  useEffect(() => {
    const unsubscribes: Array<() => void> = []

    for (const [url, handle] of Object.entries(handles)) {
      const onChange = (payload: DocHandleChangePayload<T>) => {
        setDocuments(prev => ({ ...prev, [url]: payload.doc }))
      }
      const onDelete = (_payload: DocHandleDeletePayload<T>) => {
        setDocuments(prev => {
          const { [url]: _, ...rest } = prev
          return rest
        })
      }

      handle.on("change", onChange)
      handle.on("delete", onDelete)

      // Add cleanup function for this handle
      const unsubscribe = () => {
        handle.off("change", onChange)
        handle.off("delete", onDelete)
      }
      unsubscribes.push(unsubscribe)
    }

    // Cleanup function: remove all listeners
    return () => {
      unsubscribes.forEach(fn => fn())
    }
  }, [handles])

  return documents
}
