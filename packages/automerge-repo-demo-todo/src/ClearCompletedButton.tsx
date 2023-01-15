import cx from "classnames"
import { VISIBILITY_FILTERS } from "./constants"
import { TodoProps } from "./Todo"

export function ClearCompletedButton() {
  // const dispatch = useDispatch()

  // don't render this button if there are no completed todos
  const completedTodos: TodoProps[] = []

  //useSelector(
  //   getFilteredTodos(VISIBILITY_FILTERS.COMPLETED)
  // )

  const destroyCompletedTodos = (e: any) =>
    completedTodos.forEach(({ id }) => {
      //dispatch(destroyTodo(id))
    })

  return completedTodos.length > -1 ? (
    <button
      className={cx(
        "leading-none border py-2 px-4 rounded-md",
        "hover:border-primary-600 hover:bg-primary-500 hover:text-white"
      )}
      onClick={destroyCompletedTodos}
    >
      Clear completed
    </button>
  ) : null
}
