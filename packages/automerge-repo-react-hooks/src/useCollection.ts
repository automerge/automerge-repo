import { AnyDocumentId, AutomergeUrl, DocHandle, Progress as RepoProgress, Index, CollectionHandle } from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim/next"
import { useCallback, useEffect, useRef, useState } from "react"
import { useRepo } from "./useRepo.js"

export type Progress = { type: "beginning" } | RepoProgress<{index: Index, addDoc: (url: AutomergeUrl) => void} | undefined>

export function useCollection(
  id?: AnyDocumentId
): Progress {
  let [progress, setProgress] = useState<Progress>({ type: "beginning" })
  const repo = useRepo()

  useEffect(() => {
    let isMounted = true
    let collection: CollectionHandle | undefined

    function onDocAdded() {
      if (isMounted) {
        // Shallow clone the index to trigger a re-render
        let index: Index | undefined
        if (collection) {
          index = { ...collection.index }
          setProgress({ type: "done", value: { index, addDoc: collection.add.bind(collection.add) } })
        }
      }
    }

    function cleanup() {
      isMounted = false
      if (collection) {
        collection.off("doc_added", onDocAdded)
      }
    }

    if (!id) {
      setProgress({ type: "done", value: undefined })
    } else {
      console.log("findCollection", id);
      (async () => {
        for await (const step of repo.findCollection(id)) {
          console.log("step", step)
          if (!isMounted) {
            break;
          }
          if (step.type === "done") {
            if (step.value != null) {
              collection = step.value
              console.log("collection", collection)
              collection.on("doc_added", onDocAdded)
              setProgress({type: "done", value: {index: step.value.index, addDoc: step.value.add.bind(step.value)}})
            } else {
              setProgress({type: "done", value: undefined})
            }
          } else {
            setProgress(step)
          }
        }
      })()
    }

    return cleanup
  }, [id, repo])
  return progress
}
