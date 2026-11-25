import type {
  AnyDocType,
  AutomergeDocType,
  AutomergeUrl,
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
  DocTypeOption,
  MaybeAccessor,
  UseDocHandleOptions,
  DocAndHandle,
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
  T = unknown,
  D extends AnyDocType = AutomergeDocType,
  S = T,
>(
  url: MaybeAccessor<AutomergeUrl<NameOf<D>> | undefined>,
  options?: UseDocHandleOptions & DocTypeOption<D, S>
): DocAndHandle<DocHandle<S, {}, KindOf<D>>> {
  return useDocSignalIn(repoFor(options), url, options) as DocAndHandle<
    DocHandle<S, {}, KindOf<D>>
  >
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
