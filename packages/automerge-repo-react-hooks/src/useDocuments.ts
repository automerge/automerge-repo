import {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
  DocHandleDeletePayload,
  DocumentId,
  isValidAutomergeUrl,
  parseAutomergeUrl,
} from "@automerge/automerge-repo/slim"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

/**
 * Maintains a map of document states, keyed by DocumentId. Useful for collections of related
 * documents.
 * Accepts either URLs or document IDs in the input array, but all get converted to IDs
 * for the output map.
 */
export const useDocuments = <T>(idsOrUrls?: DocId[]) => {
  const [documents, setDocuments] = useState({} as Record<DocumentId, T>)
  const repo = useRepo()
  const ids = useMemo(
    () =>
      idsOrUrls?.map(idOrUrl => {
        if (isValidAutomergeUrl(idOrUrl)) {
          const { documentId } = parseAutomergeUrl(idOrUrl)
          return documentId
        } else {
          return idOrUrl as DocumentId
        }
      }) ?? [],
    [idsOrUrls]
  )
  const prevIds = useRef<DocumentId[]>([])

  useEffect(() => {
    // These listeners will live for the lifetime of this useEffect
    // and be torn down when the useEffect is rerun.
    const listeners = {} as Record<DocumentId, Listeners<T>>
    const updateDocument = (id: DocId, doc?: T) => {
      if (doc) setDocuments(docs => ({ ...docs, [id]: doc }))
    }
    const addListener = (handle: DocHandle<T>) => {
      const id = handle.documentId

      // whenever a document changes, update our map
      const listenersForDoc: Listeners<T> = {
        change: ({ doc }) => updateDocument(id, doc),
        delete: () => removeDocument(id),
      }
      handle.on("change", listenersForDoc.change)
      handle.on("delete", listenersForDoc.delete)

      // store the listener so we can remove it later
      listeners[id] = listenersForDoc
    }

    const removeDocument = (id: DocumentId) => {
      // remove the document from the document map
      setDocuments(docs => {
        const { [id]: _removedDoc, ...remainingDocs } = docs
        return remainingDocs
      })
    }

    // Add a new document to our map
    const addNewDocument = (id: DocumentId) => {
      const handle = repo.find<T>(id)
      if (handle.docSync()) {
        updateDocument(id, handle.docSync())
        addListener(handle)
      } else {
        // As each document loads, update our map
        handle
          .doc()
          .then(doc => {
            updateDocument(id, doc)
            addListener(handle)
          })
          .catch(err => {
            console.error(`Error loading document ${id} in useDocuments: `, err)
          })
      }
    }

    const teardown = () => {
      Object.entries(listeners).forEach(([id, listeners]) => {
        const handle = repo.find<T>(id as DocId)
        handle.off("change", listeners.change)
        handle.off("delete", listeners.delete)
      })
    }

    if (!ids) {
      return teardown
    }

    for (const id of ids) {
      const handle = repo.find<T>(id)
      if (prevIds.current.includes(id)) {
        // the document was already in our list before.
        // we only need to register new listeners.
        addListener(handle)
      } else {
        // This is a new document that was not in our list before.
        // We need to update its state in the documents array and register
        // new listeners.
        addNewDocument(id)
      }
    }

    // remove any documents that are no longer in the list
    const removedIds = prevIds.current.filter(id => !ids.includes(id))
    removedIds.forEach(removeDocument)

    // Update the ref so we remember the old IDs for next time
    prevIds.current = ids

    return teardown
  }, [ids, repo])

  return documents
}

type DocId = DocumentId | AutomergeUrl
type ChangeListener<T> = (p: DocHandleChangePayload<T>) => void
type DeleteListener<T> = (p: DocHandleDeletePayload<T>) => void
type Listeners<T> = { change: ChangeListener<T>; delete: DeleteListener<T> }
