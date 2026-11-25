import type {
  AnyDocType,
  AnyDocumentId,
  AnyHandleKind,
  AutomergeDocType,
  DocHandle,
  KindOf,
  NameOf,
  Of,
  Repo,
} from "@automerge/automerge-repo/slim"
import { wrapPromise, type PromiseWrapper } from "./wrapPromise.js"
import { useRepo } from "./useRepo.js"
import { cacheKey, handleCache, normalizeId } from "./handleCache.js"
import { useEffect, useRef, useState } from "react"

export interface UseDocHandleSuspendingParams {
  suspense: true
}
export interface UseDocHandleSynchronousParams {
  suspense: false
}

export type UseDocHandleParams =
  | UseDocHandleSuspendingParams
  | UseDocHandleSynchronousParams

/** The option of a hook opening a document of the doc type `D`, for
 * documents of shape `S`: as `repo.find`'s `{ docType }`. Without it, an
 * Automerge document. */
export type DocTypeOption<D, S> = { docType?: Of<D, S> }

/** @internal A handle of a document of any type. */
export type AnyHandle = DocHandle<any, {}, AnyHandleKind>

/** @internal What the hooks take, at runtime. */
export type AnyHookParams = {
  suspense?: boolean
  docType?: AnyDocType
}

/**
 * The handle for a document, from the Repo in {@link RepoContext}, as a
 * plain `DocHandle`. In app code, prefer the `useDocHandle` from
 * {@link createRepoHooks}: its handles have the features the Repo's backend
 * adds.
 *
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does.
 */
export function useDocHandle<
  T = unknown,
  D extends AnyDocType = AutomergeDocType,
  S = T,
>(
  id: AnyDocumentId<NameOf<D>>,
  params: UseDocHandleSuspendingParams & DocTypeOption<D, S>
): DocHandle<S, {}, KindOf<D>>
export function useDocHandle<
  T = unknown,
  D extends AnyDocType = AutomergeDocType,
  S = T,
>(
  id: AnyDocumentId<NameOf<D>> | undefined,
  params?: { suspense?: false } & DocTypeOption<D, S>
): DocHandle<S, {}, KindOf<D>> | undefined
export function useDocHandle(
  id: AnyDocumentId | undefined,
  params?: AnyHookParams
): AnyHandle | undefined {
  return useDocHandleIn(useRepo(), id, params)
}

/** @internal {@link useDocHandle} on a given Repo. */
export function useDocHandleIn(
  repo: Repo,
  id: AnyDocumentId | undefined,
  { suspense = false, docType }: AnyHookParams = {}
): AnyHandle | undefined {
  const controllerRef = useRef<AbortController | undefined>(undefined)
  // With the Repo it came from: a handle found on another Repo (the provided
  // one changed) is not this Repo's.
  const [found, setFound] = useState<
    { repo: Repo; handle: AnyHandle } | undefined
  >()
  const handle = found?.repo === repo ? found.handle : undefined
  const name = docType?.name

  let currentHandle: AnyHandle | undefined =
    // make sure the handle matches the id
    id && handle && handle.url === normalizeId(id, name) ? handle : undefined

  // Typed as Automerge's: `repo.query` and `repo.find` default to it.
  const options = { docType } as { docType: AnyDocType }
  if (id && !currentHandle) {
    // Preserve synchronous initial values; find() resolves asynchronously.
    const state = repo.query(id as AnyDocumentId<string>, options).state()
    if (state.status === "ready") {
      currentHandle = state.handle as AnyHandle
    }
  }

  const cache = handleCache(repo)
  const key = id ? cacheKey(id, name) : undefined
  let wrapper = key ? cache.get(key) : undefined
  if (!wrapper && id && key) {
    controllerRef.current?.abort()
    controllerRef.current = new AbortController()

    const promise = repo.find(id as AnyDocumentId<string>, {
      ...options,
      signal: controllerRef.current.signal,
    })
    wrapper = wrapPromise(promise) as PromiseWrapper<DocHandle<unknown>>
    cache.set(key, wrapper)
  }

  /* From here we split into two paths: suspense and not.
   * In the suspense path, we return the wrapper directly.
   * In the non-suspense path, we wait for the promise to resolve
   * and then set the handle via setState. Suspense relies on
   * re-running this function until it succeeds, whereas the synchronous
   * form uses a setState to track the value. */
  useEffect(() => {
    if (currentHandle || suspense || !wrapper) {
      return
    }
    // Stays true until this effect run is torn down (unmount or id change); a
    // result that arrives after that must not setState for a stale id.
    let active = true
    wrapper.promise
      .then(handle => {
        if (active) setFound({ repo, handle: handle as AnyHandle })
      })
      .catch(() => {
        // Drop the failed wrapper so a later render retries instead of reusing
        // the rejection.
        if (key && cache.get(key) === wrapper) cache.delete(key)
        if (active) setFound(undefined)
      })
    return () => {
      active = false
    }
  }, [currentHandle, suspense, wrapper, key, cache, repo])

  if (currentHandle || !suspense || !wrapper) {
    return currentHandle
  }

  return wrapper.read() as AnyHandle
}
