import type {
  AutomergeUrl,
  Doc,
  DocHandle,
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
export default function useDocSignal<T extends object>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>] {
  return useDocSignalIn<T>(repoFor(options), url, options)
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
