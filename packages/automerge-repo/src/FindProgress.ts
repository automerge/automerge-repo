import { DocHandle } from "./DocHandle.js"

export type FindProgressState = FindProgress<unknown>["state"]
export type FindProgressWithHandleState =
  FindProgressWithHandle<unknown>["state"]

interface FindProgressBase {
  state: FindProgressState
}

interface FindProgressLoading extends FindProgressBase {
  state: "loading"
  progress: number
}

interface FindProgressRequesting<T> extends FindProgressBase {
  state: "requesting"
  progress: number
  handle: DocHandle<T>
}

interface FindProgressReady<T> extends FindProgressBase {
  state: "ready"
  handle: DocHandle<T>
}

interface FindProgressFailed extends FindProgressBase {
  state: "failed"
  error: Error
}

interface FindProgressUnavailable extends FindProgressBase {
  state: "unavailable"
}

interface FindProgressAborted extends FindProgressBase {
  state: "aborted"
}

export type FindProgressWithHandle<T> =
  | FindProgressRequesting<T>
  | FindProgressReady<T>

export type FindProgress<T> =
  | FindProgressLoading
  | FindProgressRequesting<T> // needs to return the handle for docsynchronizer but others shouldn't see it
  | FindProgressReady<T>
  | FindProgressFailed
  | FindProgressUnavailable
  | FindProgressAborted

export function isProgressWithHandle<T>(
  progress: FindProgress<T>
): progress is FindProgressWithHandle<T> {
  return progress.state === "requesting" || progress.state === "ready"
}
