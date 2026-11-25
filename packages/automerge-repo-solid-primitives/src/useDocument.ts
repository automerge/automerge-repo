import type {
  AnyDocType,
  AutomergeDocType,
  DocHandle,
  DocumentUrl,
  KindOf,
  Repo,
  SchemeOf,
} from "@automerge/automerge-repo/slim"
import createDocSignal from "./createDocSignal.js"
import createDocumentProjection from "./createDocumentProjection.js"
import { repoFor, useDocHandleIn } from "./useDocHandle.js"
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
  T = unknown,
  D extends AnyDocType = AutomergeDocType,
  S = T,
>(
  url: MaybeAccessor<DocumentUrl<SchemeOf<D>> | undefined>,
  options?: UseDocHandleOptions & DocTypeOption<D, S>
): DocAndHandle<DocHandle<S, {}, KindOf<D>>> {
  return useDocumentIn(repoFor(options), url, options) as DocAndHandle<
    DocHandle<S, {}, KindOf<D>>
  >
}

/** @internal {@link useDocument} on a given Repo. */
export function useDocumentIn(
  repo: Repo,
  url: MaybeAccessor<DocumentUrl | undefined>,
  options?: Pick<AnyOptions, "~skipInitialValue" | "docType">
): [Accessor<unknown>, Resource<AnyHandle | undefined>] {
  const handle = useDocHandleIn(repo, url, options)
  const docType = options?.docType
  // Fine-grained views apply Automerge's patches.
  const doc =
    docType === undefined || docType.scheme === "automerge"
      ? createDocumentProjection(handle as Accessor<DocHandle<object>>)
      : createDocSignal(handle)
  return [doc, handle] as const
}
