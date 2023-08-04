import type { Doc, ChangeFn } from "@automerge/automerge"
import { setContext, getContext } from "svelte"
import { writable } from "svelte/store"
import {
  Repo,
  DocumentId,
  DocHandleChangePayload,
} from "@automerge/automerge-repo"

const ContextRepoKey = Symbol("svelte-context-automerge-repo")

export function getContextRepo(): Repo {
  return getContext<Repo>(ContextRepoKey)
}

export function setContextRepo(repo: Repo) {
  setContext(ContextRepoKey, repo)
}

export function document<T>(documentId: DocumentId) {
  const repo = getContextRepo()
  const handle = repo.find<T>(documentId)
  const { set, subscribe } = writable<Doc<T>>(null, () => {
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
