import type {
  AnyDocType,
  AutomergeUrl,
  Doc,
  DocHandle,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import { repoFor, useDocHandleIn } from "./useDocHandle.js"
import createDocSignal from "./createDocSignal.js"
import type {
  AnyHandle,
  AnyOptions,
  DocTypeOptions,
  MaybeAccessor,
  UseDocHandleOptions,
  ValueOf,
} from "./types.js"
import type { Accessor, Resource } from "solid-js"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_. returns [doc, handle] from a URL. The handle is a plain
 * `DocHandle`; in app code, prefer the `useDocSignal` from
 * {@link createRepoPrimitives}.
 *
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does.
 * @param url a function that returns a url
 */
export default function useDocSignal<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  url: MaybeAccessor<AutomergeUrl<NameOf<D>> | undefined>,
  options: UseDocHandleOptions & DocTypeOptions<D, S>
): [
  Accessor<ValueOf<DocHandle<S, {}, KindOf<D>>> | undefined>,
  Resource<DocHandle<S, {}, KindOf<D>> | undefined>,
]
export default function useDocSignal<T extends object>(
  url: MaybeAccessor<AutomergeUrl<"automerge"> | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>]
export default function useDocSignal(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: AnyOptions
): [Accessor<unknown>, Resource<AnyHandle | undefined>] {
  return useDocSignalIn(repoFor(options), url, options)
}

/** @internal {@link useDocSignal} on a given Repo. */
export function useDocSignalIn(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<AnyOptions, "~skipInitialValue" | "docType">
): [Accessor<unknown>, Resource<AnyHandle | undefined>] {
  const handle = useDocHandleIn(repo, url, options)
  return [createDocSignal(handle), handle] as const
}
