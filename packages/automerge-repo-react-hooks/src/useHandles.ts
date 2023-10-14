import { AutomergeUrl, DocHandle, DocumentId } from "@automerge/automerge-repo"
import { useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

export interface DocUrlMap<T> {
  [url: AutomergeUrl]: T
}

/** useDocuments(docUrls)
 * maintains a map of document states from { [docUrl]: Doc<T> }
 * useful for lists and other places you might have a set of documents
 * does not include change capability at the moment
 * if you want that, consider adapting this to useHandles and send a PR
 */
export function useDocuments<T>(docUrls?: AutomergeUrl[]): DocUrlMap<T> {
  const handlersRef = useRef<DocUrlMap<DocHandle<T>>>({})
  const [documents, setDocuments] = useState<DocUrlMap<T>>({})
  const repo = useRepo()

  if (!docUrls) {
    return documents
  }

  const handlers = handlersRef.current
  const prevHandlerIds = Object.keys(handlers) as AutomergeUrl[]

  docUrls.forEach(url => {
    if (handlers[url]) {
      return
    }

    const handler = (handlers[url] = repo.find<T>(url))
    handler.doc().then(doc => {
      setDocuments(docs => ({
        ...docs,
        [url]: doc,
      }))
    })

    handler.on("change", ({ doc }) => {
      setDocuments(docs => ({
        ...docs,
        [url]: doc,
      }))
    })
  })

  /* Unregister the handles for any documents removed from the set */
  prevHandlerIds.forEach(id => {
    if (handlers[id]) {
      return
    }

    const handler = handlers[id]
    handler.off("change")
    delete handlers[id]

    // this is inefficient and we could use a .filter instead
    setDocuments(docs => {
      const copy = { ...docs }
      delete copy[id]
      return copy
    })
  })

  return documents
}
