/**
 * Anything subscribable: `DocHandle`, `EventEmitter`, `Repo`,
 * `NetworkSubsystem`, etc. Structural rather than `EventEmitter`-
 * specific so non-EventEmitter subscribers (like `DocHandle`, whose
 * listeners live in the registry) remain compatible.
 *
 * `fn` is `(...args: any[]) => any` so subscribers with zero-arg
 * events (e.g. `disconnect: () => void`) fit alongside multi-arg
 * events; the resolved value is the first arg.
 */
type Onceable = {
  once(event: any, fn: (...args: any[]) => any): unknown
}

/** Returns a promise that resolves when the given event is emitted on the given emitter. */
export const eventPromise = (emitter: Onceable, event: string) =>
  new Promise<any>(resolve => emitter.once(event, d => resolve(d)))

export const eventPromises = (emitters: Onceable[], event: string) => {
  const promises = emitters.map(emitter => eventPromise(emitter, event))
  return Promise.all(promises)
}
