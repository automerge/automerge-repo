/* c8 ignore start */

export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))

/* c8 ignore end */
