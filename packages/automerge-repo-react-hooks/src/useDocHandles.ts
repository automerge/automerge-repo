import { AutomergeUrl, DocHandle } from "@automerge/automerge-repo/slim"
import { useRef, useState, useEffect } from "react"
import { useRepo } from "./useRepo.js"
import { wrapPromise } from "./wrapPromise.js"
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
  const [handleMap, setHandleMap] = useState<DocHandleMap<T>>(() => new Map())
  const controllerRef = useRef<AbortController>()

  // First, handle suspense outside of effects
  controllerRef.current?.abort()
  controllerRef.current = new AbortController()

  // Check if we need any new wrappers
  const pendingPromises: Promise<unknown>[] = []

  for (const id of ids) {
    if (!wrapperCache.has(id)) {
      const promise = repo.find<T>(id, {
        signal: controllerRef.current.signal,
      })
      const wrapper = wrapPromise(promise)
      wrapperCache.set(id, wrapper)
    }

    // Try to read each wrapper
    const wrapper = wrapperCache.get(id)!
    try {
      wrapper.read()
      const handle = wrapper.read() as DocHandle<T>
      setHandleMap(prev => {
        const next = new Map(prev)
        next.set(id, handle)
        return next
      })
    } catch (e) {
      if (e instanceof Promise) {
        pendingPromises.push(e)
      }
    }
  }

  // If any promises are pending, suspend with Promise.all
  if (suspense && pendingPromises.length > 0) {
    throw Promise.all(pendingPromises)
  }

  useEffect(() => {
    if (!suspense) {
      controllerRef.current?.abort()
      controllerRef.current = new AbortController()
    }

    // Now safely get all available handles
    
      const wrapper = wrapperCache.get(id)
      try {
        const handle = wrapper?.read() as DocHandle<T>
        
      } catch (e) {
        if (!(e instanceof Promise)) {
          console.error(`Error loading document ${id}:`, e)
          wrapperCache.delete(id)
        }
      }
    })

    // Clear handles that are no longer in the ids array
    setHandleMap(prev => {
      const next = new Map(prev)
      for (const [id] of next) {
        if (!ids.includes(id)) {
          next.delete(id)
        }
      }
      return next
    })

    return () => {
      if (!suspense) {
        controllerRef.current?.abort()
      }
    }
  }, [repo, ids, suspense])

  return handleMap
}
