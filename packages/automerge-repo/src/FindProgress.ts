import { DocHandle } from "./DocHandle.js"

export type FindProgressState =
  | "loading"
  | "ready"
  | "failed"
  | "aborted"
  | "unavailable"

interface FindProgressBase<T> {
  state: FindProgressState
  handle: DocHandle<T>
}

interface FindProgressLoading<T> extends FindProgressBase<T> {
  state: "loading"
  progress: number
}

interface FindProgressReady<T> extends FindProgressBase<T> {
  state: "ready"
}

interface FindProgressFailed<T> extends FindProgressBase<T> {
  state: "failed"
  error: Error
}

interface FindProgressUnavailable<T> extends FindProgressBase<T> {
  state: "unavailable"
}

interface FindProgressAborted<T> extends FindProgressBase<T> {
  state: "aborted"
}

export type FindProgress<T> =
  | FindProgressLoading<T>
  | FindProgressReady<T>
  | FindProgressFailed<T>
  | FindProgressUnavailable<T>
  | FindProgressAborted<T>

export type FindProgressWithMethods<T> = FindProgress<T> & {
  next: () => Promise<FindProgressWithMethods<T>>
  // TODO: i don't like this allowableStates
  untilReady: (allowableStates: string[]) => Promise<DocHandle<T>>
}
