import type {
  AutomergeUrl,
  DocHandle,
  Repo,
} from "@automerge/automerge-repo/slim"
import { useState, useEffect } from "react"
import { useRepo } from "./useRepo.js"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { cacheKey, handleCache } from "./handleCache.js"
import { useSet } from "./helpers/useSet.js"

export interface UseDocHandlesParams {
  suspense?: boolean
}

export type DocHandleMap<T> = Map<AutomergeUrl, DocHandle<T> | undefined>

/**
 * Handles for several documents, from the Repo in {@link RepoContext}. For
 * handles typed with the features the Repo's backend adds, use
 * {@link createRepoHooks}.
 */
export function useDocHandles<T>(
  ids: AutomergeUrl[],
  params: UseDocHandlesParams = {}
): DocHandleMap<T> {
  return useDocHandlesIn<T>(useRepo(), ids, params)
}

/** The handles of `ids` that `repo` already has ready. */
function readyHandles<T>(repo: Repo, ids: Set<AutomergeUrl>): DocHandleMap<T> {
  const map: DocHandleMap<T> = new Map()
  for (const id of ids.values()) {
    let state
    try {
      state = repo.query<T>(id).state()
    } catch (e) {
      continue
    }

    if (state.status === "ready") {
      map.set(id, state.handle)
    }
  }
  return map
}

/** @internal {@link useDocHandles} on a given Repo. */
export function useDocHandlesIn<T>(
  repo: Repo,
  ids: AutomergeUrl[],
  { suspense = false }: UseDocHandlesParams = {}
): Map<AutomergeUrl, DocHandle<T> | undefined> {
  const idSet = useSet(ids)
  // Initialize the map with any handles that are ready
  const [found, setFound] = useState(() => ({
    repo,
    map: readyHandles<T>(repo, idSet),
  }))
  let handleMap = found.map
  if (found.repo !== repo) {
    // The provided Repo changed: its handles replace the other Repo's.
    handleMap = readyHandles<T>(repo, idSet)
    setFound({ repo, map: handleMap })
  }
  const setHandleMap = (map: DocHandleMap<T>) => setFound({ repo, map })

  const pendingPromises: PromiseWrapper<DocHandle<T>>[] = []
  const pendingIds: AutomergeUrl[] = []
  const nextHandleMap = new Map<AutomergeUrl, DocHandle<T> | undefined>()

  const cache = handleCache(repo)
  // Check if we need any new wrappers
  for (const id of idSet.values()) {
    let handle = handleMap.get(id)
    const key = cacheKey(id)
    let wrapper = cache.get(key)
    if (!wrapper) {
      try {
        const promise = repo.find<T>(id)
        wrapper = wrapPromise(promise)
        cache.set(key, wrapper)
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
        pendingIds.push(id)
      } else {
        nextHandleMap.set(id, undefined)
      }
    }
  }

  // Suspense is handled quasi-synchronously below by throwing if we still have
  // unresolved promises.
  useEffect(() => {
    // Stays true until this effect run is torn down; if idSet changes (or we
    // unmount) before these finds settle, the now-stale map must not overwrite
    // a newer one.
    let active = true
    if (pendingPromises.length > 0) {
      void Promise.allSettled(pendingPromises.map(p => p.promise)).then(
        handles => {
          if (!active) return
          // Keyed by the requested URL, which may differ from handle.url.
          handles.forEach((r, i) => {
            if (r.status === "fulfilled")
              nextHandleMap.set(pendingIds[i], r.value as DocHandle<T>)
          })
          setHandleMap(nextHandleMap)
        }
      )
    } else {
      setHandleMap(nextHandleMap)
    }
    return () => {
      active = false
    }
  }, [suspense, idSet, repo])

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
