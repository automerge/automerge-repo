import { AutomergeUrl } from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim"
import { useCallback, useEffect, useState } from "react"
import { useDocHandles } from "./useDocHandles.js"

type DocMap<T> = Map<AutomergeUrl, Doc<T>>
type ChangeDocFn<T> = (
  id: AutomergeUrl,
  changeFn: ChangeFn<T>,
  options?: ChangeOptions<T>
) => void

interface UseDocumentsOptions {
  suspense?: boolean
}

export function useDocuments<T>(
  ids: AutomergeUrl[],
  { suspense = true }: UseDocumentsOptions = {}
): [DocMap<T>, ChangeDocFn<T>] {
  const handleMap = useDocHandles<T>(ids, { suspense })
  const [docMap, setDocMap] = useState<DocMap<T>>(() => new Map())

  useEffect(() => {
    const listeners = new Map<AutomergeUrl, () => void>()

    handleMap.forEach((handle, id) => {
      if (handle) {
        const onChange = () => {
          setDocMap(prev => {
            const next = new Map(prev)
            next.set(id, handle.doc())
            return next
          })
        }

        // Initial state
        setDocMap(prev => {
          const next = new Map(prev)
          next.set(id, handle.doc())
          return next
        })

        handle.on("change", onChange)
        listeners.set(id, onChange)
      }
    })

    // Clear docs that are no longer in handleMap
    setDocMap(prev => {
      const next = new Map(prev)
      for (const [id] of next) {
        if (!handleMap.has(id)) {
          next.delete(id)
        }
      }
      return next
    })

    return () => {
      handleMap.forEach((handle, id) => {
        const listener = listeners.get(id)
        if (handle && listener) {
          handle.removeListener("change", listener)
        }
      })
    }
  }, [handleMap])

  const changeDoc = useCallback(
    (id: AutomergeUrl, changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => {
      const handle = handleMap.get(id)
      if (handle) {
        handle.change(changeFn, options)
      }
    },
    [handleMap]
  )

  return [docMap, changeDoc]
}
