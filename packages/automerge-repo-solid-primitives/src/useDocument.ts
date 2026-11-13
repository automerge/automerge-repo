import type {
  AsHandle,
  AutomergeUrl,
  Doc,
  DocHandle,
  DocOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import createDocumentProjection from "./createDocumentProjection.js"
import { repoFor, useDocHandleIn } from "./useDocHandle.js"
import type { MaybeAccessor, UseDocHandleOptions } from "./types.js"
import type { Accessor, Resource } from "solid-js"

/**
 * get a fine-grained live view of a document, and its handle, from a URL.
 * @param url a function that returns a url
 */
export default function useDocument<X extends object>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<DocOf<X>> | undefined>, Resource<AsHandle<X> | undefined>] {
  return useDocumentIn(repoFor(options), url, options) as [
    Accessor<Doc<DocOf<X>> | undefined>,
    Resource<AsHandle<X> | undefined>,
  ]
}

/** @internal {@link useDocument} on a given Repo. */
export function useDocumentIn<T extends object>(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<UseDocHandleOptions, "~skipInitialValue">
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>] {
  const handle = useDocHandleIn<T>(repo, url, options)
  return [createDocumentProjection<T>(handle), handle] as const
}
