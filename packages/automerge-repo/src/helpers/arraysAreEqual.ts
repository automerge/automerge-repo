export function arraysAreEqual<T>(
  a: ArrayLike<T>,
  b: ArrayLike<T>,
  equals: (x: T, y: T) => boolean = (x, y) => x === y
): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!equals(a[i], b[i])) return false
  return true
}
