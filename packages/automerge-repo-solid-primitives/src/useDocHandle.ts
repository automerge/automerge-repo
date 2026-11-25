import type {
  AnyDocType,
  AutomergeUrl,
  DocHandle,
  KindOf,
  NameOf,
  Repo,
} from "@automerge/automerge-repo/slim"
import {
  createEffect,
  createResource,
  useContext,
  type Resource,
} from "solid-js"
import { RepoContext } from "./context.js"
import type {
  AnyHandle,
  AnyOptions,
  DocTypeOptions,
  MaybeAccessor,
  UseDocHandleOptions,
} from "./types.js"

/**
 * get a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 * from an
 * [AutomergeUrl](https://automerge.org/automerge-repo/types/_automerge_automerge_repo.AutomergeUrl.html)
 * as a
 * [Resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).
 * Waits for the handle to be ready. The handle is a plain `DocHandle`; in app
 * code, prefer the `useDocHandle` from {@link createRepoPrimitives}, whose
 * handles have the features the Repo's backend adds.
 *
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does.
 */
// `_T` lets `useDocHandle<T>` instantiate every overload; the last one,
// Automerge's, is what `ReturnType` reads.
export default function useDocHandle<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  url: MaybeAccessor<AutomergeUrl<NameOf<D>> | undefined>,
  options: UseDocHandleOptions & DocTypeOptions<D, S>
): Resource<DocHandle<S, {}, KindOf<D>> | undefined>
export default function useDocHandle<T>(
  url: MaybeAccessor<AutomergeUrl<"automerge"> | undefined>,
  options?: UseDocHandleOptions
): Resource<DocHandle<T> | undefined>
export default function useDocHandle(
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: AnyOptions
): Resource<AnyHandle | undefined> {
  return useDocHandleIn(repoFor(options), url, options)
}

/** @internal `options.repo`, else the one in {@link RepoContext}. */
export function repoFor(options?: UseDocHandleOptions): Repo {
  const contextRepo = useContext(RepoContext)
  if (!options?.repo && !contextRepo) {
    throw new Error("use outside <RepoContext> requires options.repo")
  }
  return (options?.repo || contextRepo)!
}

/** @internal {@link useDocHandle} on a given Repo. */
export function useDocHandleIn(
  repo: Repo,
  url: MaybeAccessor<AutomergeUrl | undefined>,
  options?: Pick<AnyOptions, "~skipInitialValue" | "docType">
): Resource<AnyHandle | undefined> {
  // Typed as Automerge's: `repo.query` and `repo.find` default to it.
  const docTypeOptions = { docType: options?.docType } as {
    docType: AnyDocType
  }

  function getExistingHandle() {
    if (options?.["~skipInitialValue"]) return undefined
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) return undefined
    // Preserve synchronous initial values; find() resolves asynchronously.
    const state = repo.query(unwrappedURL, docTypeOptions).state()
    return state.status === "ready" ? (state.handle as AnyHandle) : undefined
  }

  const [handle, { mutate }] = createResource(
    url,
    url => repo.find(url, docTypeOptions) as Promise<AnyHandle>,
    { initialValue: getExistingHandle() }
  )

  createEffect(() => {
    const unwrappedURL = typeof url == "function" ? url() : url
    if (!unwrappedURL) {
      mutate()
    }
  })

  return handle
}
