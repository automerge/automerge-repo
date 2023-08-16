import {Heads} from "@automerge/automerge"
import { arraysAreEqual } from "./arraysAreEqual.js"

export const headsAreSame = (a: Heads, b: Heads) => {
  return arraysAreEqual(a, b)
}
