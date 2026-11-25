import type {
  AnyDocType,
  AutomergeKind,
  AutomergeUrl,
  DocHandle,
  HandleKind,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim"
import { useCallback, useEffect, useState } from "react"
import { useDocHandlesIn } from "./useDocHandles.js"
import type { AnyHookParams, DocTypeParams } from "./useDocHandle.js"
import { useRepo } from "./useRepo.js"

export type DocMap<T> = Map<AutomergeUrl, Doc<T>>
export type ChangeDocFn<T> = (
  id: AutomergeUrl,
  changeFn: ChangeFn<T>,
  options?: ChangeOptions<T>
) => Promise<void>

export interface UseDocumentsOptions {
  suspense?: boolean
}

/**
 * What `useDocuments` returns for documents of shape `S` whose doc type's
 * handles are `K`: Automerge's as a {@link DocMap} and {@link ChangeDocFn},
 * others' as their handles' `doc()` and `change`.
 */
export type UseDocumentsReturnOf<S, K extends HandleKind> = [K] extends [
  AutomergeKind,
]
  ? [DocMap<S>, ChangeDocFn<S>]
  : [
      Map<
        AutomergeUrl,
        Exclude<ReturnType<DocHandle<S, {}, K>["doc"]>, undefined>
      >,
      (
        id: AutomergeUrl,
        ...args: Parameters<DocHandle<S, {}, K>["change"]>
      ) => Promise<void>,
    ]

/**
 * Several documents and a function to change them, from the Repo in
 * {@link RepoContext}. In app code, prefer the `useDocuments` from
 * {@link createRepoHooks}, so all hooks come from one place.
 *
 * Opens Automerge documents unless `docType` names another doc type, as
 * `repo.find` does.
 */
export function useDocuments<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  ids: AutomergeUrl<NameOf<D>>[],
  options: UseDocumentsOptions & DocTypeParams<D, S>
): UseDocumentsReturnOf<S, KindOf<D>>
export function useDocuments<T>(
  ids: AutomergeUrl<"automerge">[],
  options?: UseDocumentsOptions
): [DocMap<T>, ChangeDocFn<T>]
export function useDocuments(
  ids: AutomergeUrl[],
  options?: AnyHookParams
): [
  Map<AutomergeUrl, unknown>,
  (id: AutomergeUrl, ...args: any[]) => Promise<void>,
] {
  return useDocumentsIn(useRepo(), ids, options)
}

/** @internal {@link useDocuments} on a given Repo. */
export function useDocumentsIn(
  repo: Repo,
  ids: AutomergeUrl[],
  { suspense = true, docType }: AnyHookParams = {}
): [
  Map<AutomergeUrl, unknown>,
  (id: AutomergeUrl, ...args: any[]) => Promise<void>,
] {
  const handleMap = useDocHandlesIn(repo, ids, { suspense, docType })
  const [docMap, setDocMap] = useState(() => {
    const docs = new Map<AutomergeUrl, unknown>()
    handleMap.forEach((handle, id) => {
      if (handle) docs.set(id, handle.doc())
    })
    return docs
  })

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
    async (id: AutomergeUrl, ...args: any[]) => {
      const handle = handleMap.get(id)
      if (handle) {
        return handle.change(...(args as [any]))
      }
    },
    [handleMap]
  )

  return [docMap, changeDoc]
}
