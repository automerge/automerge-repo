import {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
  DocumentId,
} from "@automerge/automerge-repo"
import { useEffect, useState } from "react"
import { useRepo } from "./useRepo.js"

/**
 * Maintains a map of document states, keyed by URL or DocumentId. Useful for collections of related
 * documents.
 */
export const useDocuments = <T>(ids?: DocId[]) => {
  const [documents, setDocuments] = useState({} as Record<DocId, T>)
  const [listeners, setListeners] = useState({} as Record<DocId, Listener<T>>)
  const repo = useRepo()

  useEffect(
    () => {
      const updateDocument = (id: DocId, doc?: T) => {
        if (doc) setDocuments(docs => ({ ...docs, [id]: doc }))
      }

      const addListener = (handle: DocHandle<T>) => {
        const id = handle.documentId

        // whenever a document changes, update our map
        const listener: Listener<T> = ({ doc }) => updateDocument(id, doc)
        handle.on("change", listener)

        // store the listener so we can remove it later
        setListeners(listeners => ({ ...listeners, [id]: listener }))
      }

      const removeDocument = (id: DocId) => {
        // remove the listener
        const handle = repo.find<T>(id)
        handle.off("change", listeners[id])

        // remove the document from the document map
        setDocuments(docs => {
          const { [id]: _removedDoc, ...remainingDocs } = docs
          return remainingDocs
        })
      }

      if (ids) {
        // add any new documents
        const newIds = ids.filter(id => !documents[id])
        newIds.forEach(id => {
          const handle = repo.find<T>(id)
          // As each document loads, update our map
          handle.doc().then(doc => {
            updateDocument(id, doc)
            addListener(handle)
          })
        })

        // remove any documents that are no longer in the list
        const removedIds = Object.keys(documents)
          .map(id => id as DocId)
          .filter(id => !ids.includes(id))
        removedIds.forEach(removeDocument)
      }

      // on unmount, remove all listeners
      const teardown = () => {
        Object.entries(listeners).forEach(([id, listener]) => {
          const handle = repo.find<T>(id as DocId)
          handle.off("change", listener)
        })
      }

      return teardown
    },
    [ids] // only run this effect when the list of ids changes
  )

  return documents
}

type DocId = DocumentId | AutomergeUrl
type Listener<T> = (p: DocHandleChangePayload<T>) => void
