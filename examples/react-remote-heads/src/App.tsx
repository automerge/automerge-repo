import { useDocument, AutomergeUrl } from "@automerge/react"
import cx from "clsx"
import { useRef, useState } from "react"

import { SyncStatus } from "./SyncStatus.js"
import { Todo } from "./Todo.js"
import { ExtendedArray, Filter, State, TodoData } from "./types.js"

export function App({ url }: { url: AutomergeUrl }) {
  const [state, changeState] = useDocument<State>(url)

  const newTodoInput = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState<Filter>(Filter.all)

  // Every todo lives inline in this single document, so each of these mutations
  // is a change to *this* doc — the same doc the SyncStatus indicator watches.
  const addTodo = (content: string) => {
    changeState(s => {
      s.todos.push({ id: crypto.randomUUID(), content, completed: false })
    })
  }

  const toggle = (id: string) => {
    changeState(s => {
      const todo = s.todos.find(t => t.id === id)
      if (todo) todo.completed = !todo.completed
    })
  }

  const edit = (id: string, content: string) => {
    changeState(s => {
      const todo = s.todos.find(t => t.id === id)
      if (todo) todo.content = content
    })
  }

  const destroy = (id: string) => {
    changeState(s => {
      const todos = s.todos as ExtendedArray<TodoData>
      const index = todos.findIndex(t => t.id === id)
      if (index !== -1) todos.deleteAt(index)
    })
  }

  const destroyCompleted = () => {
    changeState(s => {
      const todos = s.todos as ExtendedArray<TodoData>
      // walk backwards so deletions don't shift the indices we still need
      for (let i = todos.length - 1; i >= 0; i--) {
        if (todos[i].completed) todos.deleteAt(i)
      }
    })
  }

  if (!state) return null

  return (
    <>
      <div className="flex h-screen pt-2 pb-96 bg-primary-50">
        <div className="m-auto w-4/5 max-w-xl border border-neutral-300 shadow-md rounded-md bg-white">
          {/* sync status */}
          <div className="px-3 py-2 border-b border-neutral-200 flex justify-between items-center">
            <span className="text-xs font-medium text-gray-400">todos</span>
            <SyncStatus url={url} />
          </div>

          {/* new todo form */}
          <header>
            <form
              onSubmit={e => {
                e.preventDefault()
                if (!newTodoInput.current) return

                const newTodoText = newTodoInput.current.value.trim()

                // don't create empty todos
                if (newTodoText.length === 0) return

                addTodo(newTodoText)

                // clear input
                newTodoInput.current.value = ""
              }}
            >
              <input
                className="w-full p-3 rounded-md"
                placeholder="Add a new todo"
                ref={newTodoInput}
                autoFocus={true}
              />
            </form>
          </header>

          {/* todos */}
          <section>
            <ul className="border-y divide-y divide-solid">
              {state.todos.map(todo => (
                <Todo
                  key={todo.id}
                  todo={todo}
                  onToggle={toggle}
                  onEdit={edit}
                  onDestroy={destroy}
                  filter={filter}
                />
              ))}
            </ul>
          </section>

          {/* footer tools */}
          <footer className="p-3 flex justify-between items-center text-sm">
            {/* filter */}
            <ul className="flex-1 flex space-x-1 cursor-pointer">
              {Object.keys(Filter).map(k => {
                const key = k as Filter
                const active = key === filter

                const buttonStyle = cx({
                  ["text-gray-500 hover:text-gray-700 px-3 py-2 font-medium text-sm rounded-md"]:
                    !active,
                  ["bg-gray-100 text-gray-700 px-3 py-2 font-medium text-sm rounded-md"]:
                    active,
                })

                return (
                  <li className="leading-none" key={`filter-${key}`}>
                    <button
                      className={buttonStyle}
                      onClick={e => {
                        e.preventDefault()
                        setFilter(key)
                      }}
                    >
                      {key}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex-1 text-right">
              <button
                className={cx(
                  "leading-none border py-2 px-4 rounded-md",
                  "hover:border-primary-600 hover:bg-primary-500 hover:text-white"
                )}
                onClick={e => {
                  e.preventDefault()
                  destroyCompleted()
                }}
              >
                Clear completed
              </button>
            </div>
          </footer>
        </div>
      </div>
    </>
  )
}
