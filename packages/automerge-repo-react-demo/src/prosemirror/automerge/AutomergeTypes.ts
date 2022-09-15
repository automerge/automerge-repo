import * as Automerge from "automerge-js"

export type AutomergeTransaction = ChangeSet[]

export type ChangeSetDeletion = {
  pos: number
  val: string
}

export type ChangeSetAddition = {
  start: number
  end: number
}

export type ChangeSet = {
  add: ChangeSetAddition[]
  del: ChangeSetDeletion[]
}

export type TextKeyOf<T> = {
  // for all keys in T
  [K in keyof T]: // if the value of this key is a string, keep it. Else, discard it
  T[K] extends Automerge.Text ? K : never

  // Get the union type of the remaining values.
}[Extract<keyof T, string>]
