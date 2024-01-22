import { AutomergeUrl, DocHandle, DocumentId } from "@automerge/automerge-repo"
import { useEffect, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

/**
 * Maintains a map of document states, keyed by URL or DocumentId. Useful for lists and other places
 * you might have a set of documents. Does not include change capability at the moment; if you want
 * that, consider adapting this to useHandles and send a PR.
 */
export function useDocuments<T>(ids?: AutomergeId[]): Record<AutomergeId, T> {
  const prevIds = usePrevious(ids) || []
  const [documents, setDocuments] = useState<Record<AutomergeId, T>>({})
  const [handles, setHandles] = useState<Record<AutomergeId, DocHandle<T>>>({})

  const repo = useRepo()

  if (ids) {
    const newIds = ids.filter(id => !prevIds.includes(id))
    newIds.forEach(id => {
      const handle = repo.find<T>(id)
      setHandles(handles => ({ ...handles, [id]: handle }))
      handle.doc().then(doc => {
        setDocuments(docs => ({ ...docs, [id]: doc }))
      })
      handle.on("change", ({ doc }) => {
        setDocuments(docs => ({ ...docs, [id]: doc }))
      })
    })

    const removedIds = prevIds.filter(id => !ids.includes(id))

    /* Unregister the handles for any documents removed from the set */
    removedIds.forEach(id => handles[id].off("change"))

    /* Remove the documents from state */
    setDocuments(documents => {
      const newDocuments = { ...documents }
      removedIds.forEach(id => delete newDocuments[id])
      return newDocuments
    })
  }

  return documents
}

// https://robinvdvleuten.nl/post/use-previous-value-through-a-react-hook/
export const usePrevious = <T>(value: T): T | undefined => {
  // Create a reference to hold the previous version of the value, as it is basically a generic
  // object whose `current` property can hold any value.
  const ref = useRef<T>()
  // Use the `useEffect` hook to run a callback...
  useEffect(() => {
    // ...to store the passed value on the ref's current property...
    ref.current = value
  }, [value]) // ...whenever the value changes.
  // And return the currently stored value, as this will run before the `useEffect` callback runs.
  return ref.current
}

type AutomergeId = DocumentId | AutomergeUrl
