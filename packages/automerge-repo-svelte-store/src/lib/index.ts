import type {
  AnyDocType,
  AutomergeUrl,
  ChangeFn,
  Doc,
  DocHandle,
  DocumentId,
  HandleOf,
  InitOf,
  KindOf,
  NameOf,
  Of,
  Repo,
} from "@automerge/automerge-repo/slim"

import { getContext, setContext } from "svelte"
import { writable, type Writable } from "svelte/store"

// Store the repo in context for easy access
const REPO_CONTEXT_KEY = Symbol("automerge-repo")

/**
 * Set the Automerge Repo in the Svelte context
 * @param repo The Automerge Repo instance
 */
export function setContextRepo(repo: Repo): void {
  setContext(REPO_CONTEXT_KEY, repo)
}

/**
 * Get the Automerge Repo from the Svelte context, typed as `R` (a plain
 * `Repo` by default; not checked)
 * @returns The Automerge Repo instance
 */
export function getContextRepo<R extends Repo = Repo>(): R {
  const repo = getContext<R>(REPO_CONTEXT_KEY)
  if (!repo) {
    throw new Error(
      "No Automerge Repo found in context. Did you call setContextRepo?"
    )
  }
  return repo
}

/** Whether `H` is a handle of a doc type other than Automerge. */
type IsOtherDocType<H> = H extends { readonly "~name": infer N }
  ? [N] extends ["automerge"]
    ? false
    : true
  : false

/** The value of a store whose handle is `H`: `Doc<T>` for Automerge, or
 * what the handle's `doc()` returns. */
export type StoreValue<T, H> =
  IsOtherDocType<H> extends true
    ? H extends { doc(): infer V }
      ? V
      : Doc<T>
    : Doc<T>

/** What a store whose handle is `H` changes its document with: a
 * `ChangeFn<T>` for Automerge, or what the handle's `change` takes. */
export type StoreChangeArgs<T, H> =
  IsOtherDocType<H> extends true
    ? H extends { change(...args: infer A): unknown }
      ? A
      : [changeFn: ChangeFn<T>]
    : [changeFn: ChangeFn<T>]

/**
 * The Automerge document store interface. `H` is its handle's type: a plain
 * `DocHandle<T>` unless the store comes from a Repo whose backend adds
 * features to handles, or is of another doc type.
 */
export interface AutomergeDocumentStore<
  T,
  H = DocHandle<T>,
> extends Writable<StoreValue<T, H> | null> {
  /**
   * Make changes to the document, as its handle's `change` does
   * @param changeFn Function that modifies the document
   */
  change(...args: StoreChangeArgs<T, H>): Promise<void>

  /**
   * The URL of the document
   */
  readonly url: AutomergeUrl

  /**
   * The ID of the document
   */
  readonly documentId: DocumentId

  /**
   * The underlying Automerge document handle
   */
  readonly handle: H
}

/** The store for a document of the doc type `D`, of shape `S`, in a Repo of
 * type `R`. */
type DocTypeStore<R extends Repo, D, S> = AutomergeDocumentStore<
  S,
  HandleOf<R, S, KindOf<D>>
>

/** What {@link createAutomergeStore} returns for a Repo of type `R`. Opens
 * Automerge documents unless `docType` names another doc type, as
 * `repo.find` does. */
export interface AutomergeStores<R extends Repo> {
  /** Find a document by URL and create a reactive wrapper */
  find<_T = unknown, D extends AnyDocType = AnyDocType, S = unknown>(
    automergeUrl: AutomergeUrl<NameOf<D>>,
    options: { docType: Of<D, S> }
  ): Promise<DocTypeStore<R, D, S> | null>
  find<T>(
    automergeUrl: AutomergeUrl<"automerge">
  ): Promise<AutomergeDocumentStore<T, HandleOf<R, T>> | null>
  /** Create a new document and wrap it with reactive state */
  create<_T = unknown, D extends AnyDocType = AnyDocType, S = unknown>(
    initialContent: InitOf<D, S>,
    options: { docType: Of<D, S> }
  ): Promise<DocTypeStore<R, D, S>>
  create<T>(
    initialContent?: T
  ): Promise<AutomergeDocumentStore<T, HandleOf<R, T>>>
  /** Delete a document */
  delete(automergeUrl: AutomergeUrl): Promise<void>
  getRepo(): R
}

/** A handle of any doc type, as the stores use it. */
type AnyHandle = {
  readonly url: AutomergeUrl
  readonly documentId: DocumentId
  doc(): unknown
  change(...args: any[]): Promise<void>
  on(event: "change", fn: (payload: { doc: unknown }) => void): unknown
}

type DocTypeOptions = { docType?: AnyDocType }

/**
 * Creates an Automerge-repo store using standard Svelte stores. Its stores'
 * handles are typed with the features `repo`'s backend adds to them.
 * @param repo A configured Automerge Repo instance
 * @returns API for interacting with Automerge-repo
 */
export function createAutomergeStore<R extends Repo>(
  repo: R
): AutomergeStores<R> {
  if (!repo) {
    throw new Error("A Repo instance is required")
  }
  // Typed as Automerge's: `repo.find` and `repo.create` default to it.
  const anyRepo = repo as unknown as {
    find(url: AutomergeUrl, options?: DocTypeOptions): Promise<AnyHandle>
    create(init?: unknown, options?: DocTypeOptions): Promise<AnyHandle>
  }

  const find = async (automergeUrl: AutomergeUrl, options?: DocTypeOptions) => {
    const handle = await anyRepo.find(automergeUrl, options)
    if (!handle) return null
    return createDocumentStore(handle)
  }

  const create = async (initialContent?: unknown, options?: DocTypeOptions) => {
    const handle = await anyRepo.create(initialContent, options)
    return createDocumentStore(handle)
  }

  const deleteDocument = async (automergeUrl: AutomergeUrl) => {
    return repo.delete(automergeUrl)
  }

  /**
   * Create a reactive document store for a handle
   */
  function createDocumentStore(handle: AnyHandle) {
    // Create a writable store with the current document
    const { subscribe, set } = writable<unknown>(handle.doc() ?? null)

    // Set up change listener
    const onChange = ({ doc }: { doc: unknown }) => {
      set(doc ?? null)
    }

    // Subscribe to changes
    handle.on("change", onChange)

    // Create the store implementation
    const store = {
      subscribe,
      set,
      update: (updater: (value: unknown) => unknown) => {
        // doc() may return undefined; the store value is `null` then
        // (matching onChange above).
        const currentDoc = handle.doc()
        const newValue = updater(currentDoc ?? null)
        set(newValue)
      },

      // Method to make changes to the document
      change(...args: unknown[]) {
        return handle.change(...args)
      },

      // Metadata accessors
      get url() {
        return handle.url
      },

      get documentId() {
        return handle.documentId
      },

      // Access to the underlying handle
      get handle() {
        return handle
      },
    }

    return store
  }

  // Return the store API
  return {
    find,
    create,
    delete: deleteDocument,
    getRepo: () => repo,
  } as AutomergeStores<R>
}

/**
 * Create a document store from a document ID or URL
 * Uses the repo from context if no repo is provided. For handles typed with
 * the features the Repo's backend adds, use {@link createAutomergeStore}.
 * Opens an Automerge document unless `docType` names another doc type, as
 * `repo.find` does.
 * @param docIdOrUrl The document ID or URL
 * @param repoOrOptions Optional Automerge Repo instance, or the doc type
 * and optional Repo
 * @returns A promise resolving to the document store
 */
export function document<
  _T = unknown,
  D extends AnyDocType = AnyDocType,
  S = unknown,
>(
  docIdOrUrl: DocumentId | AutomergeUrl<NameOf<D>>,
  options: { docType: Of<D, S>; repo?: Repo }
): Promise<DocTypeStore<Repo, D, S> | null>
export function document<T>(
  docIdOrUrl: DocumentId | AutomergeUrl<"automerge">,
  repoInstance?: Repo
): Promise<AutomergeDocumentStore<T> | null>
export function document(
  docIdOrUrl: DocumentId | AutomergeUrl,
  repoOrOptions?: Repo | { docType: AnyDocType; repo?: Repo }
): Promise<AutomergeDocumentStore<unknown> | null> {
  const options =
    repoOrOptions && "docType" in repoOrOptions ? repoOrOptions : undefined
  const repo =
    (options ? options.repo : (repoOrOptions as Repo | undefined)) ||
    getContextRepo()
  const store = createAutomergeStore(repo)
  return options
    ? store.find(docIdOrUrl as AutomergeUrl, { docType: options.docType })
    : store.find(docIdOrUrl as AutomergeUrl)
}
