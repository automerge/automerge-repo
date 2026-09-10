/**
 * Whether `promise` settled before `ms` elapsed.
 *
 * `withTimeout` cannot express this: it resolves `undefined` on timeout, so
 * for a promise that itself resolves `undefined` the two outcomes are
 * indistinguishable and an assertion on the result can never fail.
 */
export default async function settledWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<false>(resolve => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true), deadline])
  } finally {
    clearTimeout(timer!)
  }
}
