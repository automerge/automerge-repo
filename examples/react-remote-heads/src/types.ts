/** Inside an Automerge change function, any arrays found on the document have these utility functions */
export interface ExtendedArray<T> extends Array<T> {
  insertAt(index: number, ...args: T[]): ExtendedArray<T>
  deleteAt(index: number, numDelete?: number): ExtendedArray<T>
}

/**
 * Unlike the sibling `react-todo` example (one Automerge document per todo),
 * here every todo lives inline in a single root document. That means *every*
 * action — add, toggle, edit, delete — is a change to this one doc, so the
 * SyncStatus indicator (which watches this doc) reflects all activity.
 */
export interface State {
  todos: TodoData[]
}

export interface TodoData {
  id: string
  content: string
  completed: boolean
}

export const Filter = {
  all: "all",
  incomplete: "incomplete",
  completed: "completed",
} as const
export type Filter = (typeof Filter)[keyof typeof Filter]
