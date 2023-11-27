export function assert(value: boolean, message?: string): asserts value
export function assert<T>(
  value: T | undefined,
  message?: string
): asserts value is T
export function assert(value: any, message?: string) {
  if (value === false || value === null || value === undefined)
    throw new Error(message || "Assertion failed")
}
