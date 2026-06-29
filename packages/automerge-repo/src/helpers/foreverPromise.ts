/* c8 ignore start */
/**
 * A promise that never settles.
 *
 * @deprecated A promise that never settles is undesirable: anything that awaits
 * or races it is retained for the whole session (see @remarks). Only the
 * deprecated `DocHandle.whenReady` still uses it, and it will be removed
 * alongside it.
 *
 * @remarks
 * Do NOT race this (e.g. `Promise.race([foreverPromise, x])` or
 * `abortable(foreverPromise, signal)`): racing a never-settling singleton appends
 * a reaction to it that is never released, so the race and everything it captures
 * are retained for the whole session. To make a wait cancelable, derive the
 * promise from the signal instead: from a `{ once: true }` `abort` listener,
 * reject with `signal.reason` (handling the already-aborted case) so the promise
 * can settle, and remove the listener once your wait resolves. {@link abortable}
 * applies this to a single promise; for a deadline use {@link withTimeout}.
 */
export const foreverPromise = new Promise<never>(() => {})
/* c8 ignore end */
