/**
 * # Svelte store for Automerge Repo
 * 
 * ## Example Usage
 * 
 * For a working example, see the [Svelte counter demo](../automerge-repo-demo-counter-svelte/).
 * 
 * @example 
 * 
 * ```svelte
 * // App.svelte
 * <script lang="ts">
 *   import { Repo } from "@automerge/automerge-repo"
 *   import Counter from './lib/Counter.svelte'
 *   import { setContextRepo } from "@automerge/automerge-repo-svelte-store"
 * 
 *   const repo = new Repo({storage: new SomeStorage() })
 * 
 *   // Make the `Repo` available to child components (via Svelte's `setContext`).
 *   setContextRepo(repo)
 * 
 *   const docId = repo.create()
 * </script>
 * 
 * <main>
 *   <div class="card">
 *     <Counter {docId}/>
 *   </div>
 * </main>
 * ```
 * 
 * 
 * ```svelte
 * // Counter.svelte`
 * <script lang="ts">
 *   import type { DocumentId } from "@automerge/automerge-repo"
 *   import { document } from "@automerge/automerge-repo-svelte-store"
 * 
 *   export let docId: DocumentId
 * 
 *   // `document` calls `getContextRepo` internally to access the closest `Repo`.
 *   const doc = document<{count?: number}>(docId)
 *   const increment = () => {
 *     doc.change((d) => d.count = (d.count || 0) + 1)
 *   }
 * </script>
 * 
 * <button on:click={increment}>
 *   count is {$doc?.count || 0}
 * </button>
 * ```
 * 
 * ## Contributors
 * Originally written by Dylan MacKenzie ([@ecstatic-morse](https://github.com/ecstatic-morse)).
 *  * @packageDocumentation
**/

import type { ChangeFn, Doc } from "@automerge/automerge/next"
import {
  AutomergeUrl,
  DocHandleChangePayload,
  Repo,
} from "@automerge/automerge-repo"
import { getContext, setContext } from "svelte"
import { writable } from "svelte/store"

const ContextRepoKey = Symbol("svelte-context-automerge-repo")

export function getContextRepo(): Repo {
  return getContext<Repo>(ContextRepoKey)
}

export function setContextRepo(repo: Repo) {
  setContext(ContextRepoKey, repo)
}

export function document<T>(documentId: AutomergeUrl) {
  const repo = getContextRepo()
  const handle = repo.find<T>(documentId)
  const { set, subscribe } = writable<Doc<T>>(handle.docSync(), () => {
    const onChange = (h: DocHandleChangePayload<T>) => set(h.doc)
    handle.addListener("change", onChange)
    return () => handle.removeListener("change", onChange)
  })

  return {
    subscribe,
    change: (fn: ChangeFn<T>) => {
      handle.change(fn)
    },
  }
}
