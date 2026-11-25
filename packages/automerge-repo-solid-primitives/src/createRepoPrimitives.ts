import type {
  AnyDocType,
  AutomergeDocType,
  DocumentUrl,
  HandleOf,
  KindOf,
  Repo,
  SchemeOf,
} from "@automerge/automerge-repo/slim"
import {
  createComponent,
  createContext,
  useContext,
  type JSX,
  type Resource,
} from "solid-js"
import autoproduce from "./autoproduce.js"
import { RepoContext } from "./context.js"
import createDocSignal from "./createDocSignal.js"
import createDocumentProjection from "./createDocumentProjection.js"
import makeDocSignal from "./makeDocSignal.js"
import makeDocumentProjection from "./makeDocumentProjection.js"
import type {
  AnyOptions,
  DocAndHandle,
  DocTypeOption,
  MaybeAccessor,
  UseDocHandleOptions,
} from "./types.js"
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
  useDocHandle<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    url: MaybeAccessor<DocumentUrl<SchemeOf<D>> | undefined>,
    options?: RepoPrimitiveOptions & DocTypeOption<D, S>
  ): Resource<HandleOf<R, S, KindOf<D>> | undefined>
  /** As the package's `useDocument`, typed for this Repo. */
  useDocument<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    url: MaybeAccessor<DocumentUrl<SchemeOf<D>> | undefined>,
    options?: RepoPrimitiveOptions & DocTypeOption<D, S>
  ): DocAndHandle<HandleOf<R, S, KindOf<D>>>
  /** As the package's `useDocSignal`, typed for this Repo. */
  useDocSignal<T = unknown, D extends AnyDocType = AutomergeDocType, S = T>(
    url: MaybeAccessor<DocumentUrl<SchemeOf<D>> | undefined>,
    options?: RepoPrimitiveOptions & DocTypeOption<D, S>
  ): DocAndHandle<HandleOf<R, S, KindOf<D>>>
  // The package's primitives that take a handle, so all come from one place.
  autoproduce: typeof autoproduce
  createDocSignal: typeof createDocSignal
  makeDocSignal: typeof makeDocSignal
  createDocumentProjection: typeof createDocumentProjection
  makeDocumentProjection: typeof makeDocumentProjection
}

/**
 * A provider and every primitive, typed for one Repo type, with the features
 * its backend adds to handles. The recommended way to use the primitives:
 * make them once next to the Repo and import them all from there. Pass the
 * Repo to infer its type, or give the type if the Repo is made later:
 *
 * ```tsx
 * export const repo = new Repo({ backend })
 * export const { RepoProvider, useDocHandle, useDocument } =
 *   createRepoPrimitives(repo)
 * // or: createRepoPrimitives<Repo<SubductionExtensions>>()
 *
 * <RepoProvider value={repo}>…</RepoProvider>
 * ```
 *
 * The provider only accepts a Repo of that type, so these primitives cannot
 * disagree with it. Each call makes its own provider, so several Repos can
 * be used at once. The primitives that find documents throw outside their
 * provider. The Repo passed here is only read for its type.
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
    useDocHandle: ((
      url: MaybeAccessor<DocumentUrl | undefined>,
      options?: AnyOptions
    ) =>
      useDocHandleIn(
        useRepo(),
        url,
        options
      )) as RepoPrimitives<R>["useDocHandle"],
    useDocument: ((
      url: MaybeAccessor<DocumentUrl | undefined>,
      options?: AnyOptions
    ) =>
      useDocumentIn(
        useRepo(),
        url,
        options
      )) as RepoPrimitives<R>["useDocument"],
    useDocSignal: ((
      url: MaybeAccessor<DocumentUrl | undefined>,
      options?: AnyOptions
    ) =>
      useDocSignalIn(
        useRepo(),
        url,
        options
      )) as RepoPrimitives<R>["useDocSignal"],
    autoproduce,
    createDocSignal,
    makeDocSignal,
    createDocumentProjection,
    makeDocumentProjection,
  }
}
