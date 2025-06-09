import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim"
import { useState, useEffect } from "react"
import { useRepo } from "./useRepo.js"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { wrapperCache } from "./useDocHandle.js"

interface UseDocHandlesParams {
  suspense?: boolean
}

type DocHandleMap<T> = Map<AutomergeUrl, DocHandle<T> | undefined>

export function useDocHandles<T>(
  ids: AutomergeUrl[],
  { suspense = false }: UseDocHandlesParams = {}
): DocHandleMap<T> {
  const repo = useRepo()
  const [handleMap, setHandleMap] = useState<DocHandleMap<T>>(() => {
    const map = new Map()

    // Initialize the map with any handles that are ready
    for (const id of ids) {
      let progress
      try {
        progress = repo.findWithProgress<T>(id)
      } catch (e) {
        continue
      }

      if (progress.state === "ready") {
        map.set(id, progress.handle)
      }
    }

    return map
  })

  const pendingPromises: PromiseWrapper<DocHandle<T>>[] = []
  const nextHandleMap = new Map<AutomergeUrl, DocHandle<T> | undefined>()

  // Check if we need any new wrappers
  for (const id of ids) {
    let handle = handleMap.get(id)
    let wrapper = wrapperCache.get(id)
    if (!wrapper) {
      try {
        const promise = repo.find<T>(id)
        wrapper = wrapPromise(promise)
        wrapperCache.set(id, wrapper)
      } catch (e) {
        continue
      }
    }

    // Try to read each wrapper.
    // Update handleMap with any available handles,
    // and collect any pending promises
    try {
      handle ??= wrapper.read() as DocHandle<T>
      nextHandleMap.set(id, handle)
    } catch (e) {
      if (e instanceof Promise) {
        pendingPromises.push(wrapper as PromiseWrapper<DocHandle<T>>)
      } else {
        nextHandleMap.set(id, undefined)
      }
    }
  }

  // Suspense is handled quasi-synchronously below by throwing if we still have
  // unresolved promises.
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

  // If any promises are pending, suspend with Promise.all
  // Note that this behaviour is different from the synchronous
  // form where we get gradual load-in of child documents.
  // I couldn't find an obvious way of incremental loading with
  // a single hook for suspense.
  // (But maybe with suspense this hook is less useful?)
  if (suspense && pendingPromises.length > 0) {
    throw Promise.all(pendingPromises.map(p => p.promise))
  }

  return handleMap
}
