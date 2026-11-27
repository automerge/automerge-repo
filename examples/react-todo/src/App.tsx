import { useDocument, useRepo, type AutomergeUrl } from "@automerge/react"
import cx from "clsx"
import { Suspense, useRef, useState } from "react"

import { Todo } from "./Todo.js"
import { ExtendedArray, Filter, State, TodoData } from "./types.js"

export function App({ url }: { url: AutomergeUrl }) {
  const [state, changeState] = useDocument<State>(url)

  const newTodoInput = useRef<HTMLInputElement>(null)
  const [filter, setFilter] = useState<Filter>(Filter.all)

  const repo = useRepo()

  const destroy = (url: AutomergeUrl) => {
    return changeState(s => {
      const todos = s.todos as ExtendedArray<AutomergeUrl>
      const index = todos.findIndex(_ => _ === url)
      if (index >= 0) todos.deleteAt(index)
    })
  }

  const destroyCompleted = async () => {
    if (!state) return
    const completed = await Promise.all(
      state.todos.map(async url => ({
        url,
        completed: (await repo.find<TodoData>(url)).doc()?.completed,
      }))
    )
    const urls = new Set(
      completed.filter(todo => todo.completed).map(todo => todo.url)
    )
    if (urls.size === 0) return
    await changeState(s => {
      const todos = s.todos as ExtendedArray<AutomergeUrl>
      for (let index = todos.length - 1; index >= 0; index--)
        if (urls.has(todos[index])) todos.deleteAt(index)
    })
  }

  if (!state) return null

  return (
    <>
      <div className="flex h-screen pt-2 pb-96 bg-primary-50">
        <div className="m-auto w-4/5 max-w-xl border border-neutral-300 shadow-md rounded-md bg-white">
          {/* new todo form */}
          <header>
            <form
              onSubmit={e => {
                e.preventDefault()
                if (!newTodoInput.current) return

                const newTodoText = newTodoInput.current.value.trim()

                // don't create empty todos
                if (newTodoText.length === 0) return

                newTodoInput.current.value = ""
                void (async () => {
                  const handle = await repo.create<TodoData>({
                    content: newTodoText,
                    completed: false,
                  })
                  await changeState(s => {
                    s.todos.push(handle.url)
                  })
                })().catch(console.error)
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
            <Suspense fallback={<li>Loading todo items...</li>}>
              <ul className="border-y divide-y divide-solid">
                {state.todos.map(url => (
                  <Todo
                    key={url}
                    url={url}
                    onDestroy={url => {
                      void destroy(url).catch(console.error)
                    }}
                    filter={filter}
                  />
                ))}
              </ul>
            </Suspense>
          </section>

          {/* footer tools */}
          <footer className="p-3 flex justify-between items-center text-sm">
            {/* remaining count */}
            {/* <span className="flex-1">
              <strong>{incompleteCount}</strong>{" "}
              {pluralize(incompleteCount, "item")} left
            </span> */}

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
                  void destroyCompleted().catch(console.error)
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
