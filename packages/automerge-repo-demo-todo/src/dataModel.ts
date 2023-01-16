import { DocumentId } from "automerge-repo"
import { v4 as uuid } from "uuid"

/** Inside an Automerge change function, any arrays found on the document have these utility functions */
interface ExtendedArray<T> extends Array<T> {
  insertAt(index: number, ...args: T[]): ExtendedArray<T>
  deleteAt(index: number, numDelete?: number): ExtendedArray<T>
}

type ChangeFn = (s: State) => void

export type State = {
  todos: TodoData[]
  filter: Filter
}

export interface TodoData {
  id: DocumentId
  content: string
  completed: boolean
}

export const Filter = {
  all: "all",
  incomplete: "incomplete",
  completed: "completed",
} as const
export type Filter = typeof Filter[keyof typeof Filter]

// "reducers"

export const setFilter =
  (filter: Filter): ChangeFn =>
  s => {
    s.filter = filter
  }

export const addTodo =
  (content: string): ChangeFn =>
  s => {
    s.todos.push({
      id: uuid() as DocumentId,
      content,
      completed: false,
    })
  }

export const destroyTodo =
  (id: DocumentId): ChangeFn =>
  s => {
    const todos = s.todos as ExtendedArray<TodoData>
    const index = todos.findIndex(t => t.id === id)
    todos.deleteAt(index)
  }

export const toggleTodo =
  (id: DocumentId): ChangeFn =>
  s => {
    const todo = getTodo(s, id)
    if (todo) todo.completed = !todo.completed
  }

export const editTodo =
  (id: DocumentId, content: string): ChangeFn =>
  s => {
    const todo = getTodo(s, id)
    if (todo) todo.content = content
  }

export const destroyCompletedTodos: ChangeFn = s => {
  const completed = getFilteredTodos(s, Filter.completed)
  completed.forEach(t => destroyTodo(t.id)(s))
}

// "selectors"

export const getFilter = (s: State) => s.filter

export const getTodo = (s: State, id: DocumentId) =>
  s.todos.find(t => t.id === id)

export const getAllTodos = (s: State) => s.todos

export const getFilteredTodos = (s: State, filter: Filter) => {
  switch (filter) {
    case Filter.all:
      return getAllTodos(s)
    case Filter.incomplete:
      return getAllTodos(s).filter(t => !t.completed)
    case Filter.completed:
      return getAllTodos(s).filter(t => t.completed)
    default:
      return []
  }
}

export const getVisibleTodos = (s: State) => getFilteredTodos(s, getFilter(s))
