import { ChangeFn } from "@automerge/automerge"

export type Change<T> = (cf: ChangeFn<T>) => void
