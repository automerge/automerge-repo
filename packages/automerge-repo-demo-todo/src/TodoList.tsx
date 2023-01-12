import { Todo, TodoProps } from "./Todo"

export const TodoList = () => {
  const todos = [] as TodoProps[]

  return (
    <ul className="todo-list">
      {todos && todos.map((todo) => <Todo key={`todo-${todo.id}`} {...todo} />)}
    </ul>
  )
}
