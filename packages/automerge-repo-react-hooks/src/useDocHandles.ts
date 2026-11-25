import type {
  AnyDocType,
  AutomergeUrl,
  DocHandle,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import { useState, useEffect } from "react"
import { useRepo } from "./useRepo.js"
import { PromiseWrapper, wrapPromise } from "./wrapPromise.js"
import { cacheKey, handleCache } from "./handleCache.js"
import { useSet } from "./helpers/useSet.js"
import type { AnyHandle, AnyHookParams, DocTypeParams } from "./useDocHandle.js"

export interface UseDocHandlesParams {
  suspense?: boolean
}

export type DocHandleMap<T> = Map<AutomergeUrl, DocHandle<T> | undefined>

/**
 * Handles for several documents, from the Repo in {@link RepoContext}, as
 * plain `DocHandle`s. In app code, prefer the `useDocHandles` from
 * {@link createRepoHooks}: its handles have the features the Repo's backend
 * adds.
 *
 * Opens Automerge documents unless `docType` names another doc type, as
 * `repo.find` does.
 */
export function useDocHandles<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  ids: AutomergeUrl<NameOf<D>>[],
  params: UseDocHandlesParams & DocTypeParams<D, S>
): Map<AutomergeUrl, DocHandle<S, {}, KindOf<D>> | undefined>
export function useDocHandles<T>(
  ids: AutomergeUrl<"automerge">[],
  params?: UseDocHandlesParams
): DocHandleMap<T>
export function useDocHandles(
  ids: AutomergeUrl[],
  params: AnyHookParams = {}
): Map<AutomergeUrl, AnyHandle | undefined> {
  return useDocHandlesIn(useRepo(), ids, params)
}

/** The handles of `ids` that `repo` already has ready. */
function readyHandles(
  repo: Repo,
  ids: Set<AutomergeUrl>,
  docType: AnyDocType | undefined
): Map<AutomergeUrl, AnyHandle | undefined> {
  const map = new Map<AutomergeUrl, AnyHandle | undefined>()
  for (const id of ids.values()) {
    let state
    try {
      state = repo.query(id, { docType } as { docType: AnyDocType }).state()
    } catch (e) {
      continue
    }

    if (state.status === "ready") {
      map.set(id, state.handle as AnyHandle)
    }
  }
  return map
}

/** @internal {@link useDocHandles} on a given Repo. */
export function useDocHandlesIn(
  repo: Repo,
  ids: AutomergeUrl[],
  { suspense = false, docType }: AnyHookParams = {}
): Map<AutomergeUrl, AnyHandle | undefined> {
  type HandleMap = Map<AutomergeUrl, AnyHandle | undefined>
  const idSet = useSet(ids)
  // Initialize the map with any handles that are ready
  const [found, setFound] = useState(() => ({
    repo,
    docType,
    map: readyHandles(repo, idSet, docType),
  }))
  let handleMap = found.map
  if (found.repo !== repo || found.docType !== docType) {
    // The provided Repo (or doc type) changed: its handles replace the
    // other's.
    handleMap = readyHandles(repo, idSet, docType)
    setFound({ repo, docType, map: handleMap })
  }
  const setHandleMap = (map: HandleMap) => setFound({ repo, docType, map })

  const pendingPromises: PromiseWrapper<AnyHandle>[] = []
  const pendingIds: AutomergeUrl[] = []
  const nextHandleMap: HandleMap = new Map()

  const cache = handleCache(repo)
  // Check if we need any new wrappers
  for (const id of idSet.values()) {
    let handle = handleMap.get(id)
    const key = cacheKey(id, docType?.name)
    let wrapper = cache.get(key)
    if (!wrapper) {
      try {
        const promise = repo.find(id, { docType } as { docType: AnyDocType })
        wrapper = wrapPromise(promise) as PromiseWrapper<DocHandle<unknown>>
        cache.set(key, wrapper)
      } catch (e) {
        continue
      }
    }

    // Try to read each wrapper.
    // Update handleMap with any available handles,
    // and collect any pending promises
    try {
      handle ??= wrapper.read() as AnyHandle
      nextHandleMap.set(id, handle)
    } catch (e) {
      if (e instanceof Promise) {
        pendingPromises.push(wrapper as unknown as PromiseWrapper<AnyHandle>)
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
              nextHandleMap.set(pendingIds[i], r.value as AnyHandle)
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
  }, [suspense, idSet, repo, docType])

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
