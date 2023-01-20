export const pause = (t = 100) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
