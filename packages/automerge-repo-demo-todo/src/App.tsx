import { DocumentId } from "automerge-repo"
import { useDocument } from "automerge-repo-react-hooks"
import { AddTodo } from "./AddTodo"
import { ClearCompletedButton } from "./ClearCompletedButton"
import { pluralize } from "./pluralize"
import { TodoList } from "./TodoList"
import { VisibilityFilters } from "./VisibilityFilters"

interface Doc {
  count: number
}

export function App(props: { documentId: DocumentId }) {
  const [doc, changeDoc] = useDocument<Doc>(props.documentId)

  const activeTodos = ["", ""] //useSelector(
  //   getFilteredTodos(VISIBILITY_FILTERS.INCOMPLETE)
  // )
  const activeCount = activeTodos.length

  return (
    <div className="flex h-screen pt-2 pb-96 bg-primary-50">
      <div className="m-auto w-4/5 max-w-xl border border-neutral-300 shadow-md rounded-md bg-white">
        <header>
          <AddTodo />
        </header>
        <section>
          <TodoList />
        </section>
        <footer className="p-3 flex justify-between items-center text-sm">
          <span>
            <strong>{activeCount}</strong> {pluralize(activeCount, "item")} left
          </span>
          <VisibilityFilters />
          <ClearCompletedButton />
        </footer>

        {/* count button */}
        <div className=" p-3">
          <button
            className="bg-primary-500 hover:bg-primary-700 text-white py-1 px-3 rounded"
            onClick={() => {
              changeDoc((d: any) => {
                d.count = (d.count || 0) + 1
              })
            }}
          >
            Count: {doc?.count ?? 0}
          </button>
        </div>
      </div>
    </div>
  )
}
