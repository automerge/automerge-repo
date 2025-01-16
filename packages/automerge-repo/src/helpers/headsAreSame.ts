import { arraysAreEqual } from "./arraysAreEqual.js"
import { UrlHeads } from "../AutomergeUrl.js"

export const headsAreSame = (a: UrlHeads, b: UrlHeads) => {
  return arraysAreEqual(a, b)
}
