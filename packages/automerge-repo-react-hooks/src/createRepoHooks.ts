import type {
  AnyDocumentId,
  AutomergeUrl,
  HandleOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import {
  createContext,
  createElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react"
import {
  useDocHandleIn,
  type UseDocHandleParams,
  type UseDocHandleSuspendingParams,
  type UseDocHandleSynchronousParams,
} from "./useDocHandle.js"
import { useDocHandlesIn, type UseDocHandlesParams } from "./useDocHandles.js"
import { RepoContext } from "./useRepo.js"

/** The provider and hooks {@link createRepoHooks} makes for a Repo type `R`. */
export interface RepoHooks<R extends Repo> {
  /** Provides `value` to these hooks, and to the package's own
   * ({@link RepoContext}). Only accepts a Repo of type `R`. */
  RepoProvider(props: { value: R; children?: ReactNode }): ReactElement
  /** The provided Repo; throws outside a {@link RepoHooks.RepoProvider}. */
  useRepo(): R
  /** As the package's `useDocHandle`, typed for this Repo. */
  useDocHandle<T>(
    id: AnyDocumentId,
    params: UseDocHandleSuspendingParams
  ): HandleOf<R, T>
  useDocHandle<T>(
    id: AnyDocumentId | undefined,
    params?: UseDocHandleSynchronousParams
  ): HandleOf<R, T> | undefined
  /** As the package's `useDocHandles`, typed for this Repo. */
  useDocHandles<T>(
    ids: AutomergeUrl[],
    params?: UseDocHandlesParams
  ): Map<AutomergeUrl, HandleOf<R, T> | undefined>
}

/**
 * A provider and hooks typed for one Repo type, with the features its
 * backend adds to handles. Pass the Repo to infer its type, or give the type
 * if the Repo is made later:
 *
 * ```ts
 * export const repo = new Repo({ backend })
 * export const { RepoProvider, useRepo, useDocHandle } = createRepoHooks(repo)
 * // or: createRepoHooks<Repo<SubductionExtensions>>()
 *
 * <RepoProvider value={repo}>…</RepoProvider>
 * ```
 *
 * The provider only accepts a Repo of that type, so these hooks cannot
 * disagree with it. The Repo passed here is only read for its type.
 */
export function createRepoHooks<R extends Repo = Repo>(
  _repo?: R
): RepoHooks<R> {
  const Context = createContext<R | null>(null)

  function RepoProvider({
    value,
    children,
  }: {
    value: R
    children?: ReactNode
  }): ReactElement {
    // The package context too, for its other hooks and other components.
    return createElement(
      Context.Provider,
      { value },
      createElement(RepoContext.Provider, { value }, children)
    )
  }

  function useRepo(): R {
    const repo = useContext(Context)
    if (!repo) throw new Error("Repo was not found on its RepoProvider.")
    return repo
  }

  function useDocHandle<T>(
    id: AnyDocumentId | undefined,
    params?: UseDocHandleParams
  ): HandleOf<R, T> | undefined {
    return useDocHandleIn<T>(useRepo(), id, params) as
      | HandleOf<R, T>
      | undefined
  }

  function useDocHandles<T>(
    ids: AutomergeUrl[],
    params?: UseDocHandlesParams
  ): Map<AutomergeUrl, HandleOf<R, T> | undefined> {
    return useDocHandlesIn<T>(useRepo(), ids, params) as Map<
      AutomergeUrl,
      HandleOf<R, T> | undefined
    >
  }

  return {
    RepoProvider,
    useRepo,
    useDocHandle: useDocHandle as RepoHooks<R>["useDocHandle"],
    useDocHandles,
  }
}
