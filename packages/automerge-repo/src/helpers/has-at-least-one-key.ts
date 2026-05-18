/**
 * Test if object has at least one key
 *
 * @remarks
 * Faster than `Object.keys(obj).length > 0` for large object
 * - No Allocation: It doesn't create a massive array in memory.
 * - Short-Circuiting: If the object has 10,000 keys, Object.keys() will visit all 10,000. This function stops at the 1st key.
 *
 * Like `Object.keys()`, only own enumerable properties are considered, so behaviour is identical to `Object.keys(obj).length > 0`.
 */
export const hasAtLeastOneKey = (obj: Record<string, unknown>): boolean => {
  for (const _ in obj) {
    //https://caniuse.com/mdn-javascript_builtins_object_hasown
    if (Object.hasOwn(obj, _)) return true
  }
  return false
}
