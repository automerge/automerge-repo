import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim"
import { useState, useEffect } from "react"
import { useRepo } from "./useRepo.js"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { promiseCache } from "./useDocHandle.js"

interface UseDocHandlesParams {
  suspense?: boolean
}

type DocHandleMap<T> = Map<AutomergeUrl, DocHandle<T> | undefined>

export function useDocHandles<T>(
  ids: AutomergeUrl[],
  { suspense = false }: UseDocHandlesParams = {}
): DocHandleMap<T> {
  const repo = useRepo()
  const [handleMap, setHandleMap] = useState<DocHandleMap<T>>(() => new Map())

  const pendingPromises: PromiseWrapper<DocHandle<T>>[] = []
  const nextHandleMap = new Map<AutomergeUrl, DocHandle<T> | undefined>()

  // Check if we need any new wrappers
  for (const id of ids) {
    let wrapper = promiseCache.get(id)!
    if (!wrapper) {
      try {
        const promise = repo.find<T>(id)
        wrapper = wrapPromise(promise)
        promiseCache.set(id, wrapper)
      } catch (e) {
        continue
      }
    }

    // Try to read each wrapper.
    // Update handleMap with any available handles,
    // and collect any pending promises
    try {
      const handle = wrapper.read() as DocHandle<T>
      nextHandleMap.set(id, handle)
    } catch (e) {
      if (e instanceof Promise) {
        pendingPromises.push(wrapper as PromiseWrapper<DocHandle<T>>)
      } else {
        nextHandleMap.set(id, undefined)
      }
    }
  }

  // If any promises are pending, suspend with Promise.all
  if (suspense && pendingPromises.length > 0) {
    throw Promise.all(pendingPromises.map(p => p.promise))
  }

  useEffect(() => {
    if (pendingPromises.length > 0) {
      void Promise.allSettled(pendingPromises.map(p => p.promise)).then(
        handles => {
          handles.forEach(r => {
            if (r.status === "fulfilled") {
              const h = r.value as DocHandle<T>
              nextHandleMap.set(h.url, h)
            }
          })
          setHandleMap(nextHandleMap)
        }
      )
    } else {
      setHandleMap(nextHandleMap)
    }
  }, [suspense, ids])

  return handleMap
}
