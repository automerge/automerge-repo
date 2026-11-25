import type {
  AnyDocType,
  AnyDocumentId,
  AutomergeKind,
  DocHandle,
  HandleKind,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import { ChangeFn, ChangeOptions, Doc } from "@automerge/automerge/slim"
import { useCallback, useEffect, useState } from "react"
import {
  useDocHandleIn,
  type AnyHookParams,
  type DocTypeParams,
} from "./useDocHandle.js"
import { useRepo } from "./useRepo.js"

/**
 * A hook which returns a document and a function to change it.
 * Uses React Suspense for loading states, returning a tuple matching useState pattern.
 *
 * @example
 * ```tsx
 * function Counter() {
 *   const [doc, changeDoc] = useDocument<{ count: number }>(docUrl)
 *   return (
 *     <button onClick={() => changeDoc(d => d.count++)}>
 *       Count: {doc.count}
 *     </button>
 *   )
 * }
 *
 * // Must be wrapped in Suspense boundary
 * <Suspense fallback={<Loading />}>
 *   <Counter />
 * </Suspense>
 * ```
 */

export interface UseDocumentSuspendingParams {
  suspense: true
}
export interface UseDocumentSynchronousParams {
  suspense: false
}

export type UseDocumentParams =
  | UseDocumentSuspendingParams
  | UseDocumentSynchronousParams

export type UseDocumentReturn<T> = [
  Doc<T>,
  (changeFn: ChangeFn<T>, options?: ChangeOptions<T>) => Promise<void>,
]

/**
 * What `useDocument` returns for a document of shape `S` whose doc type's
 * handles are `K`: Automerge's as {@link UseDocumentReturn}, others' as the
 * handle's `doc()` and `change`.
 */
export type UseDocumentReturnOf<S, K extends HandleKind> = [K] extends [
  AutomergeKind,
]
  ? UseDocumentReturn<S>
  : [
      Exclude<ReturnType<DocHandle<S, {}, K>["doc"]>, undefined>,
      DocHandle<S, {}, K>["change"],
    ]

/**
 * A document and a function to change it, from the Repo in
 * {@link RepoContext}. In app code, prefer the `useDocument` from
 * {@link createRepoHooks}, so all hooks come from one place.
 *
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does; the function changes it as its handle's `change` does.
 */
// `_T` lets `useDocument<T>` instantiate every overload; the last one,
// Automerge's, is what `ReturnType` reads.
export function useDocument<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  id: AnyDocumentId<NameOf<D>>,
  params: UseDocumentSuspendingParams & DocTypeParams<D, S>
): UseDocumentReturnOf<S, KindOf<D>>
export function useDocument<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  id: AnyDocumentId<NameOf<D>> | undefined,
  params: { suspense?: false } & DocTypeParams<D, S>
): UseDocumentReturnOf<S, KindOf<D>> | [undefined, () => Promise<void>]
export function useDocument<T>(
  id: AnyDocumentId<"automerge">,
  params: UseDocumentSuspendingParams
): UseDocumentReturn<T>
export function useDocument<T>(
  id: AnyDocumentId<"automerge"> | undefined,
  params?: UseDocumentSynchronousParams
): UseDocumentReturn<T> | [undefined, () => Promise<void>]
export function useDocument(
  id: AnyDocumentId | undefined,
  params?: AnyHookParams
): [unknown, (...args: any[]) => Promise<void>] {
  return useDocumentIn(useRepo(), id, params)
}

/** @internal {@link useDocument} on a given Repo. */
export function useDocumentIn(
  repo: Repo,
  id: AnyDocumentId | undefined,
  params: AnyHookParams = { suspense: false }
): [unknown, (...args: any[]) => Promise<void>] {
  const handle = useDocHandleIn(repo, id, params)
  // Initialize with current doc state
  const [doc, setDoc] = useState<unknown>(() => handle?.doc())
  const [deleteError, setDeleteError] = useState<Error>()

  // Reinitialize doc when handle changes
  useEffect(() => {
    setDoc(() => handle?.doc())
  }, [handle])

  useEffect(() => {
    if (!handle) {
      return
    }
    const onChange = () => setDoc(() => handle.doc())
    const onDelete = () => {
      setDeleteError(new Error(`Document ${id} was deleted`))
    }

    handle.on("change", onChange)
    handle.on("delete", onDelete)

    return () => {
      handle.removeListener("change", onChange)
      handle.removeListener("delete", onDelete)
    }
  }, [handle, id])

  const changeDoc = useCallback(
    (...args: any[]) => handle!.change(...(args as [any])),
    [handle]
  )

  if (deleteError) {
    throw deleteError
  }

  if (doc === undefined) {
    return [undefined, async () => {}]
  }
  return [doc, changeDoc]
}
