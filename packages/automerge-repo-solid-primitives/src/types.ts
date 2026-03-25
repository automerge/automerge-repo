import type { Repo } from "@automerge/automerge-repo/slim"

export interface UseDocHandleOptions {
  repo?: Repo
}

export type MaybeAccessor<T> = T | (() => T)
