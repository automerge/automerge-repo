import type { Repo } from "@automerge/automerge-repo/slim"

export interface UseDocHandleOptions {
  repo?: Repo
  // @internal
  "~skipInitialValue"?: boolean
}

export type MaybeAccessor<T> = T | (() => T)
