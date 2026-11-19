import type {
  AutomergeUrl,
  Doc,
  DocHandle,
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
export default function useDocument<T extends object>(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>] {
  return useDocumentIn<T>(repoFor(options), url, options)
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
