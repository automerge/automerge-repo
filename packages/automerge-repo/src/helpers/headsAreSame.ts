import { arraysAreEqual } from "./arraysAreEqual.js"
import type { UrlHeads } from "../types.js"

export const headsAreSame = (a: UrlHeads, b: UrlHeads) => {
  return arraysAreEqual(a, b)
}
