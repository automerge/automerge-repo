export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))

export function rejectOnTimeout<T>(
  promise: Promise<T>,
  millis: number
): Promise<T> {
  return Promise.race([
    promise,
    pause(millis).then(() => {
      throw new Error("timeout exceeded")
    }),
  ])
}
