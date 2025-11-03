export default async function withTimeout<T>(
  promise: Promise<T>,
  timeout: number
): Promise<T | undefined> {
  const timeoutPromise = new Promise<T | undefined>(resolve => {
    setTimeout(() => resolve(undefined), timeout)
  })
  return Promise.race([promise, timeoutPromise])
}
