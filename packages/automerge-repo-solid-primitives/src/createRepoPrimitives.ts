import type {
  AutomergeUrl,
  Doc,
  HandleOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import {
  createComponent,
  createContext,
  useContext,
  type Accessor,
  type JSX,
  type Resource,
} from "solid-js"
import { RepoContext } from "./context.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
import { useDocHandleIn } from "./useDocHandle.js"
import { useDocSignalIn } from "./useDocSignal.js"
import { useDocumentIn } from "./useDocument.js"

/** Options of the primitives {@link createRepoPrimitives} makes: those of
 * `useDocHandle` but `repo`, which is always the provided one. */
export type RepoPrimitiveOptions = Omit<UseDocHandleOptions, "repo">

/** The provider and primitives {@link createRepoPrimitives} makes for a
 * Repo type `R`. */
export interface RepoPrimitives<R extends Repo> {
  /** Provides `value` to these primitives, and to the package's own
   * ({@link RepoContext}). Only accepts a Repo of type `R`. */
  RepoProvider(props: { value: R; children?: JSX.Element }): JSX.Element
  /** The provided Repo; throws outside a {@link RepoPrimitives.RepoProvider}. */
  useRepo(): R
  /** As the package's `useDocHandle`, typed for this Repo. */
  useDocHandle<T>(
    url: MaybeAccessor<AutomergeUrl | undefined>,
    options?: RepoPrimitiveOptions
  ): Resource<HandleOf<R, T> | undefined>
  /** As the package's `useDocument`, typed for this Repo. */
  useDocument<T extends object>(
    url: MaybeAccessor<AutomergeUrl | undefined>,
    options?: RepoPrimitiveOptions
  ): [Accessor<Doc<T> | undefined>, Resource<HandleOf<R, T> | undefined>]
  /** As the package's `useDocSignal`, typed for this Repo. */
  useDocSignal<T extends object>(
    url: MaybeAccessor<AutomergeUrl | undefined>,
    options?: RepoPrimitiveOptions
  ): [Accessor<Doc<T> | undefined>, Resource<HandleOf<R, T> | undefined>]
}

/**
 * A provider and primitives typed for one Repo type, with the features its
 * backend adds to handles. Pass the Repo to infer its type, or give the type
 * if the Repo is made later:
 *
 * ```tsx
 * export const repo = new Repo({ backend })
 * export const { RepoProvider, useDocHandle } = createRepoPrimitives(repo)
 * // or: createRepoPrimitives<Repo<"ephemeral">>()
 *
 * <RepoProvider value={repo}>…</RepoProvider>
 * ```
 *
 * The provider only accepts a Repo of that type, so these primitives cannot
 * disagree with it. The Repo passed here is only read for its type.
 */
export function createRepoPrimitives<R extends Repo = Repo>(
  _repo?: R
): RepoPrimitives<R> {
  const Context = createContext<R | null>(null)

  function useRepo(): R {
    const repo = useContext(Context)
    if (!repo) throw new Error("Repo was not found on its RepoProvider.")
    return repo
  }

  return {
    // The package context too, for its other primitives and components.
    RepoProvider: props =>
      createComponent(Context.Provider, {
        get value() {
          return props.value
        },
        get children() {
          return createComponent(RepoContext.Provider, {
            get value() {
              return props.value
            },
            get children() {
              return props.children
            },
          })
        },
      }),
    useRepo,
    useDocHandle: <T>(
      url: MaybeAccessor<AutomergeUrl | undefined>,
      options?: RepoPrimitiveOptions
    ) =>
      useDocHandleIn<T>(useRepo(), url, options) as Resource<
        HandleOf<R, T> | undefined
      >,
    useDocument: <T extends object>(
      url: MaybeAccessor<AutomergeUrl | undefined>,
      options?: RepoPrimitiveOptions
    ) =>
      useDocumentIn<T>(useRepo(), url, options) as [
        Accessor<Doc<T> | undefined>,
        Resource<HandleOf<R, T> | undefined>,
      ],
    useDocSignal: <T extends object>(
      url: MaybeAccessor<AutomergeUrl | undefined>,
      options?: RepoPrimitiveOptions
    ) =>
      useDocSignalIn<T>(useRepo(), url, options) as [
        Accessor<Doc<T> | undefined>,
        Resource<HandleOf<R, T> | undefined>,
      ],
  }
}
