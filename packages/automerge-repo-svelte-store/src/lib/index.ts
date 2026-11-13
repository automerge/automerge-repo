import type {
  AsHandle,
  AutomergeUrl,
  ChangeFn,
  Doc,
  DocHandle,
  DocOf,
  DocumentId,
  HandleOf,
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

/**
 * The Automerge document store interface. `H` is its handle's type: a plain
 * `DocHandle<T>` unless the store comes from a Repo whose backend adds
 * features to handles.
 */
export interface AutomergeDocumentStore<
  T,
  H = DocHandle<T>,
> extends Writable<Doc<T> | null> {
  /**
   * Make changes to the document
   * @param changeFn Function that modifies the document
   */
  change(changeFn: ChangeFn<T>): Promise<void>

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

/** What {@link createAutomergeStore} returns for a Repo of type `R`. */
export interface AutomergeStores<R extends Repo> {
  /** Find a document by URL and create a reactive wrapper */
  find<T>(
    automergeUrl: AutomergeUrl
  ): Promise<AutomergeDocumentStore<T, HandleOf<R, T>> | null>
  /** Create a new document and wrap it with reactive state */
  create<T>(
    initialContent?: T
  ): Promise<AutomergeDocumentStore<T, HandleOf<R, T>>>
  /** Delete a document */
  delete(automergeUrl: AutomergeUrl): Promise<void>
  getRepo(): R
}

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

  const find = async <T>(automergeUrl: AutomergeUrl) => {
    const handle = await repo.find<T>(automergeUrl)
    if (!handle) return null
    return createDocumentStore<T>(handle) as AutomergeDocumentStore<
      T,
      HandleOf<R, T>
    >
  }

  const create = async <T>(initialContent?: T) => {
    const handle = await repo.create<T>(initialContent)
    return createDocumentStore<T>(handle) as AutomergeDocumentStore<
      T,
      HandleOf<R, T>
    >
  }

  const deleteDocument = async (automergeUrl: AutomergeUrl) => {
    return repo.delete(automergeUrl)
  }

  /**
   * Create a reactive document store for a handle
   */
  function createDocumentStore<T>(
    handle: DocHandle<T>
  ): AutomergeDocumentStore<T> {
    // Create a writable store with the current document
    const { subscribe, set } = writable<Doc<T> | null>(handle.doc() ?? null)

    // Set up change listener
    const onChange = ({ doc }: { doc: Doc<T> | undefined }) => {
      set(doc ?? null)
    }

    // Subscribe to changes
    handle.on("change", onChange)

    // Create the store implementation
    const store: AutomergeDocumentStore<T> = {
      subscribe,
      set,
      update: updater => {
        // doc() returns `Doc<T> | undefined`; the store value is
        // `Doc<T> | null`, so bridge undefined -> null (matching onChange above).
        const currentDoc = handle.doc()
        const newValue = updater(currentDoc ?? null)
        set(newValue)
      },

      // Method to make changes to the document
      change(changeFn: ChangeFn<T>) {
        return handle.change(changeFn)
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
  }
}

/**
 * Create a document store from a document ID or URL
 * Uses the repo from context if no repo is provided. Takes the document type
 * (`document<Todo>`) or a handle type (`document<AppHandle<Todo>>`, with
 * `type AppHandle<T> = HandleOf<typeof repo, T>`) to be typed with the
 * features the Repo's backend adds; both assert what the Repo is.
 * {@link createAutomergeStore} is typed from its Repo instead.
 * @param docIdOrUrl The document ID or URL
 * @param repoInstance Optional Automerge Repo instance
 * @returns A promise resolving to the document store
 */
export function document<X>(
  docIdOrUrl: DocumentId | AutomergeUrl,
  repoInstance?: Repo
): Promise<AutomergeDocumentStore<DocOf<X>, AsHandle<X>> | null> {
  const repo = repoInstance || getContextRepo()
  const store = createAutomergeStore(repo)
  return store.find<DocOf<X>>(
    docIdOrUrl as AutomergeUrl
  ) as Promise<AutomergeDocumentStore<DocOf<X>, AsHandle<X>> | null>
}
