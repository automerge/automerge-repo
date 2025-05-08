import type {
  AutomergeUrl,
  ChangeFn,
  Doc,
  DocHandle,
  DocumentId,
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
 * Get the Automerge Repo from the Svelte context
 * @returns The Automerge Repo instance
 */
export function getContextRepo(): Repo {
  const repo = getContext<Repo>(REPO_CONTEXT_KEY)
  if (!repo) {
    throw new Error(
      "No Automerge Repo found in context. Did you call setContextRepo?"
    )
  }
  return repo
}

/**
 * The Automerge document store interface
 */
export interface AutomergeDocumentStore<T> extends Writable<Doc<T> | null> {
  /**
   * Make changes to the document
   * @param changeFn Function that modifies the document
   */
  change(changeFn: ChangeFn<T>): void

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
  readonly handle: DocHandle<T>
}

/**
 * Creates an Automerge-repo store using standard Svelte stores
 * @param repo A configured Automerge Repo instance
 * @returns API for interacting with Automerge-repo
 */
export function createAutomergeStore(repo: Repo) {
  if (!repo) {
    throw new Error("A Repo instance is required")
  }

  /**
   * Find a document by URL and create a reactive wrapper
   */
  const find = async <T>(
    automergeUrl: AutomergeUrl
  ): Promise<AutomergeDocumentStore<T> | null> => {
    const handle = await repo.find<T>(automergeUrl)
    if (!handle) return null
    return createDocumentStore<T>(handle)
  }

  /**
   * Create a new document and wrap it with reactive state
   */
  const create = async <T>(
    initialContent: any = {}
  ): Promise<AutomergeDocumentStore<T>> => {
    const handle = await repo.create<T>(initialContent)
    return createDocumentStore<T>(handle)
  }

  /**
   * Delete a document
   */
  const deleteDocument = async (automergeUrl: AutomergeUrl) => {
    repo.delete(automergeUrl)
  }

  /**
   * Create a reactive document store for a handle
   */
  function createDocumentStore<T>(
    handle: DocHandle<T>
  ): AutomergeDocumentStore<T> {
    // Create a writable store with the current document
    const { subscribe, set } = writable<Doc<T> | null>(handle.doc())

    // Set up change listener
    const onChange = ({ doc }: { doc: Doc<T> }) => {
      set(doc)
    }

    // Subscribe to changes
    handle.on("change", onChange)

    // Create the store implementation
    const store: AutomergeDocumentStore<T> = {
      subscribe,
      set,
      update: updater => {
        const currentDoc = handle.doc()
        const newValue = updater(currentDoc)
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
 * Uses the repo from context if no repo is provided
 * @param docIdOrUrl The document ID or URL
 * @param repoInstance Optional Automerge Repo instance
 * @returns A promise resolving to the document store
 */
export function document<T>(
  docIdOrUrl: DocumentId | AutomergeUrl,
  repoInstance?: Repo
): Promise<AutomergeDocumentStore<T> | null> {
  const repo = repoInstance || getContextRepo()
  const store = createAutomergeStore(repo)
  return store.find<T>(docIdOrUrl as AutomergeUrl)
}
