import type {
  AutomergeUrl,
  Doc,
  DocHandle,
} from "@automerge/automerge-repo/slim"
import useDocHandle from "./useDocHandle.js"
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
  const handle = useDocHandle<T>(url, options)
  return [createDocSignal<T>(handle), handle] as const
}
