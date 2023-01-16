import { DocumentId } from "automerge-repo"
import { useDocument } from "automerge-repo-react-hooks"
import cx from "classnames"
import { useRef } from "react"

import { Todo } from "./Todo"

import {
  addTodo,
  destroyCompletedTodos,
  destroyTodo,
  Filter,
  getFilter,
  getFilteredTodos,
  getVisibleTodos,
  setFilter,
  State,
  toggleTodo,
  editTodo,
} from "./dataModel"
import { pluralize } from "./pluralize"

const { incomplete, completed } = Filter

export function App(props: { rootId: DocumentId }) {
  const newTodoInput = useRef<HTMLInputElement>(null)

  const { rootId: documentId } = props
  const [state, changeState] = useDocument<State>(documentId)
  if (!state) return null

  const incompleteCount = getFilteredTodos(state, incomplete).length
  const completedCount = getFilteredTodos(state, completed).length
  return (
    <>
      <div className="flex h-screen pt-2 pb-96 bg-primary-50">
        <div className="m-auto w-4/5 max-w-xl border border-neutral-300 shadow-md rounded-md bg-white">
          <header>
            <form
              onSubmit={e => {
                if (!newTodoInput.current) return

                // don't post back
                e.preventDefault()

                const newTodoText = newTodoInput.current.value.trim()

                // don't create empty todos
                if (newTodoText.length === 0) return

                // update state with new todo
                changeState(addTodo(newTodoText))

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
              {getVisibleTodos(state).map(todo => (
                <Todo
                  key={todo.id}
                  todo={todo}
                  onToggle={id => changeState(toggleTodo(id))}
                  onEdit={(id, content) => changeState(editTodo(id, content))}
                  onDestroy={id => changeState(destroyTodo(id))}
                />
              ))}
            </ul>
          </section>

          {/* footer tools */}
          <footer className="p-3 flex justify-between items-center text-sm">
            {/* remaining count */}
            <span className="flex-1">
              <strong>{incompleteCount}</strong>{" "}
              {pluralize(incompleteCount, "item")} left
            </span>

            {/* filter */}
            <ul className="flex-1 flex space-x-1 cursor-pointer">
              {Object.keys(Filter).map(key => {
                const filter = key as Filter
                const active = filter === getFilter(state)

                const buttonStyle = cx({
                  ["text-gray-500 hover:text-gray-700 px-3 py-2 font-medium text-sm rounded-md"]:
                    !active,
                  ["bg-gray-100 text-gray-700 px-3 py-2 font-medium text-sm rounded-md"]:
                    active,
                })

                return (
                  <li className="leading-none" key={`filter-${filter}`}>
                    <button
                      className={buttonStyle}
                      onClick={e => {
                        e.preventDefault()
                        changeState(setFilter(filter))
                      }}
                    >
                      {filter}
                    </button>
                  </li>
                )
              })}
            </ul>
            <div className="flex-1 text-right">
              {completedCount > 0 && (
                <button
                  className={cx(
                    "leading-none border py-2 px-4 rounded-md",
                    "hover:border-primary-600 hover:bg-primary-500 hover:text-white"
                  )}
                  onClick={e => {
                    e.preventDefault()
                    changeState(destroyCompletedTodos)
                  }}
                >
                  Clear completed
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </>
  )
}
