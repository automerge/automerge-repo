import type {
  AnyDocType,
  AnyDocumentId,
  AutomergeDocType,
  AutomergeUrl,
  HandleOf,
  KindOf,
  NameOf,
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
  type AnyHookParams,
  type DocTypeOption,
  type UseDocHandleSuspendingParams,
} from "./useDocHandle.js"
import { useDocHandlesIn, type UseDocHandlesParams } from "./useDocHandles.js"
import {
  useDocumentIn,
  type useDocument as packageUseDocument,
} from "./useDocument.js"
import {
  useDocumentsIn,
  type useDocuments as packageUseDocuments,
} from "./useDocuments.js"
import { usePresence } from "./usePresence.js"
import { RepoContext } from "./useRepo.js"

/** The provider and hooks {@link createRepoHooks} makes for a Repo type `R`. */
export interface RepoHooks<R extends Repo> {
  /** Provides `value` to these hooks, and to the package's own
   * ({@link RepoContext}). Only accepts a Repo of type `R`. */
  RepoProvider(props: { value: R; children?: ReactNode }): ReactElement
  /** The provided Repo; throws outside a {@link RepoHooks.RepoProvider}. */
  useRepo(): R
  /** As the package's `useDocHandle`, typed for this Repo. */
  useDocHandle<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    id: AnyDocumentId<NameOf<D>>,
    params: UseDocHandleSuspendingParams & DocTypeOption<D, S>
  ): HandleOf<R, S, KindOf<D>>
  useDocHandle<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    id: AnyDocumentId<NameOf<D>> | undefined,
    params?: { suspense?: false } & DocTypeOption<D, S>
  ): HandleOf<R, S, KindOf<D>> | undefined
  /** As the package's `useDocHandles`, typed for this Repo. */
  useDocHandles<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    ids: AutomergeUrl<NameOf<D>>[],
    params?: UseDocHandlesParams & DocTypeOption<D, S>
  ): Map<AutomergeUrl, HandleOf<R, S, KindOf<D>> | undefined>
  /** As the package's `useDocument`, on this Repo. */
  useDocument: typeof packageUseDocument
  /** As the package's `useDocuments`, on this Repo. */
  useDocuments: typeof packageUseDocuments
  /** The package's `usePresence`, so all hooks come from one place. */
  usePresence: typeof usePresence
}

/**
 * A provider and every hook, typed for one Repo type, with the features its
 * backend adds to handles. The recommended way to use the hooks: make them
 * once next to the Repo and import them all from there. Pass the Repo to
 * infer its type, or give the type if the Repo is made later:
 *
 * ```ts
 * export const repo = new Repo({ backend })
 * export const { RepoProvider, useRepo, useDocHandle, useDocument } =
 *   createRepoHooks(repo)
 * // or: createRepoHooks<Repo<SubductionExtensions>>()
 *
 * <RepoProvider value={repo}>…</RepoProvider>
 * ```
 *
 * The provider only accepts a Repo of that type, so these hooks cannot
 * disagree with it. Each call makes its own provider, so several Repos can
 * be used at once. The hooks that use the Repo throw outside their provider.
 * The Repo passed here is only read for its type.
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

  function useDocHandle(id: AnyDocumentId | undefined, params?: AnyHookParams) {
    return useDocHandleIn(useRepo(), id, params)
  }

  function useDocHandles(ids: AutomergeUrl[], params?: AnyHookParams) {
    return useDocHandlesIn(useRepo(), ids, params)
  }

  function useDocument(id: AnyDocumentId | undefined, params?: AnyHookParams) {
    return useDocumentIn(useRepo(), id, params)
  }

  function useDocuments(ids: AutomergeUrl[], options?: AnyHookParams) {
    return useDocumentsIn(useRepo(), ids, options)
  }

  return {
    RepoProvider,
    useRepo,
    useDocHandle: useDocHandle as RepoHooks<R>["useDocHandle"],
    useDocHandles: useDocHandles as RepoHooks<R>["useDocHandles"],
    useDocument: useDocument as RepoHooks<R>["useDocument"],
    useDocuments: useDocuments as RepoHooks<R>["useDocuments"],
    usePresence,
  }
}
