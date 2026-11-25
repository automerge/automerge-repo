import type {
  AnyDocType,
  AutomergeUrl,
  Doc,
  DocHandle,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import createDocSignal from "./createDocSignal.js"
import createDocumentProjection from "./createDocumentProjection.js"
import { repoFor, useDocHandleIn } from "./useDocHandle.js"
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
 * get a fine-grained live view of a document, and its handle, from a URL.
 * The handle is a plain `DocHandle`; in app code, prefer the `useDocument`
 * from {@link createRepoPrimitives}.
 *
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does. Only Automerge documents' views are fine-grained: other
 * doc types' are coarse-grained, as {@link useDocSignal}'s.
 * @param url a function that returns a url
 */
export default function useDocument<
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
export default function useDocument<T extends object>(
  url: MaybeAccessor<AutomergeUrl<"automerge"> | undefined>,
  options?: UseDocHandleOptions
): [Accessor<Doc<T> | undefined>, Resource<DocHandle<T> | undefined>]
export default function useDocument(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: AnyOptions
): [Accessor<unknown>, Resource<AnyHandle | undefined>] {
  return useDocumentIn(repoFor(options), url, options)
}

/** @internal {@link useDocument} on a given Repo. */
export function useDocumentIn(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<AnyOptions, "~skipInitialValue" | "docType">
): [Accessor<unknown>, Resource<AnyHandle | undefined>] {
  const handle = useDocHandleIn(repo, url, options)
  const docType = options?.docType
  // Fine-grained views apply Automerge's patches.
  const doc =
    docType === undefined || docType.name === "automerge"
      ? createDocumentProjection(handle as Accessor<DocHandle<object>>)
      : createDocSignal(handle)
  return [doc, handle] as const
}
