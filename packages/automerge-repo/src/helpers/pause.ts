export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
