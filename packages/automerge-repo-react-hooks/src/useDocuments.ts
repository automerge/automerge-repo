import {
  AutomergeUrl,
  DocHandle,
  DocHandleChangePayload,
  DocHandleDeletePayload,
  DocumentId,
  isValidAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim"
import { useEffect, useMemo, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

/**
 * Maintains a map of document states, keyed by AutomergeUrl. Useful for collections of related
 * documents.
 * Accepts either URLs or document IDs in the input array, but all get converted to URLs
 * for the output map.
 */
export const useDocuments = <T>(idsOrUrls?: DocId[]) => {
  const repo = useRepo()
  const urls = useMemo(
    () =>
      idsOrUrls?.map(idOrUrl => {
        if (isValidAutomergeUrl(idOrUrl)) {
          return idOrUrl as AutomergeUrl
        } else {
          return stringifyAutomergeUrl(idOrUrl)
        }
      }) ?? [],
    [idsOrUrls]
  )
  const prevUrls = useRef<AutomergeUrl[]>([])
  const [documents, setDocuments] = useState(() => {
    return urls.reduce((docs, url) => {
      const handle = repo.find<T>(url)
      const doc = handle.docSync()
      if (doc) {
        docs[url] = doc
      }
      return docs
    }, {} as Record<AutomergeUrl, T>)
  })

  useEffect(() => {
    // These listeners will live for the lifetime of this useEffect
    // and be torn down when the useEffect is rerun.
    const listeners = {} as Record<AutomergeUrl, Listeners<T>>
    const updateDocument = (url: AutomergeUrl, doc?: T) => {
      if (doc) setDocuments(docs => ({ ...docs, [url]: doc }))
    }
    const addListener = (handle: DocHandle<T>) => {
      const url = stringifyAutomergeUrl(handle.documentId);

      // whenever a document changes, update our map
      const listenersForDoc: Listeners<T> = {
        change: ({ doc }) => updateDocument(url, doc),
        delete: () => removeDocument(url),
      }
      handle.on("change", listenersForDoc.change)
      handle.on("delete", listenersForDoc.delete)

      // store the listener so we can remove it later
      listeners[url] = listenersForDoc
    }

    const removeDocument = (url: AutomergeUrl) => {
      // remove the document from the document map
      setDocuments(docs => {
        const { [url]: _removedDoc, ...remainingDocs } = docs
        return remainingDocs
      })
    }

    // Add a new document to our map
    const addNewDocument = (url: AutomergeUrl) => {
      const handle = repo.find<T>(url)
      if (handle.docSync()) {
        updateDocument(url, handle.docSync())
        addListener(handle)
      } else {
        // As each document loads, update our map
        handle
          .doc()
          .then(doc => {
            updateDocument(url, doc)
            addListener(handle)
          })
          .catch(err => {
            console.error(`Error loading document ${url} in useDocuments: `, err)
          })
      }
    }

    const teardown = () => {
      Object.entries(listeners).forEach(([url, listeners]) => {
        const handle = repo.find<T>(url as AutomergeUrl)
        handle.off("change", listeners.change)
        handle.off("delete", listeners.delete)
      })
    }

    if (!urls) {
      return teardown
    }

    for (const url of urls) {
      const handle = repo.find<T>(url)
      if (prevUrls.current.includes(url)) {
        // the document was already in our list before.
        // we only need to register new listeners.
        addListener(handle)
      } else {
        // This is a new document that was not in our list before.
        // We need to update its state in the documents array and register
        // new listeners.
        addNewDocument(url)
      }
    }

    // remove any documents that are no longer in the list
    const removedUrls = prevUrls.current.filter(url => !urls.includes(url))
    removedUrls.forEach(removeDocument)

    // Update the ref so we remember the old URLs for next time
    prevUrls.current = urls

    return teardown
  }, [urls, repo])

  return documents
}

type DocId = DocumentId | AutomergeUrl
type ChangeListener<T> = (p: DocHandleChangePayload<T>) => void
type DeleteListener<T> = (p: DocHandleDeletePayload<T>) => void
type Listeners<T> = { change: ChangeListener<T>; delete: DeleteListener<T> }
