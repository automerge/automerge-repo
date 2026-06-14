// everything in this file exists to preserve backwards compatibility
// with the original `findWithProgress` API which has now moved to
// returning a {@link DocumentProgress} Delete this file when cutting the next
// major

import type { DocHandle } from "./DocHandle.js"
import type { QueryState } from "./DocumentQuery.js"

/**
 * @deprecated Use {@link DocumentProgress} and call `peek()` / `subscribe()` /
 * `whenReady()` directly. Will be removed in the next major release.
 */
export type FindProgress<T> =
  | { state: "loading"; progress: number; handle: DocHandle<T> }
  | { state: "ready"; handle: DocHandle<T> }
  | { state: "unavailable"; handle: DocHandle<T> }
  | { state: "failed"; error: Error; handle: DocHandle<T> }

/**
 * @deprecated Use {@link DocumentProgress}. Will be removed in the next major release.
 */
export type FindProgressWithMethods<T> = FindProgress<T> & {
  peek: () => FindProgress<T>
  subscribe: (callback: (progress: FindProgress<T>) => void) => () => void
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
}

/**
 * @deprecated Use {@link DocumentProgress}. Will be removed in the next major release.
 */
export type ProgressSignal<T> = {
  peek: () => FindProgress<T>
  subscribe: (callback: (progress: FindProgress<T>) => void) => () => void
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
}

/**
 * In the original automerge-repo v2 API, `findWithProgress` returned a value
 * with `state`, `handle`, `error`, and `progress` properties directly on it.
 * More recently we have moved to the {@link DocumentProgress} API that exposes a `peek()`
 * method to obtain the current state of a query. This function maps a {@link
 * QueryState} to the legacy {@link FindProgress} shape to retain backwards compatibility
 *
 * @internal TODO: remove in the next major release
 */
export function queryStateToFindProgress<T>(
  state: QueryState<T, DocHandle<any, any>>,
  handle: DocHandle<T>
): FindProgress<T> {
  switch (state.state) {
    case "ready":
      return { state: "ready", handle: state.handle as DocHandle<T> }
    case "loading":
      return { state: "loading", progress: 0, handle }
    case "unavailable":
      return { state: "unavailable", handle }
    case "failed":
      return { state: "failed", error: state.error, handle }
  }
}
