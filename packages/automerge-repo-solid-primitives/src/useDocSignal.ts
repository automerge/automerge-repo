import type {
  AsHandle,
  AutomergeUrl,
  Doc,
  DocHandle,
  DocOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import { repoFor, useDocHandleIn } from "./useDocHandle.js"
import createDocSignal from "./createDocSignal.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
import type { Accessor, Resource } from "solid-js"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_. returns [doc, handle] from a URL.
 * @param url a function that returns a url
 */
export default function useDocSignal<X extends object>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<DocOf<X>> | undefined>, Resource<AsHandle<X> | undefined>] {
  return useDocSignalIn(repoFor(options), url, options) as [
    Accessor<Doc<DocOf<X>> | undefined>,
    Resource<AsHandle<X> | undefined>,
  ]
}

/** @internal {@link useDocSignal} on a given Repo. */
export function useDocSignalIn<T extends object>(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<UseDocHandleOptions, "~skipInitialValue">
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>] {
  const handle = useDocHandleIn<T>(repo, url, options)
  return [createDocSignal<T>(handle), handle] as const
}
