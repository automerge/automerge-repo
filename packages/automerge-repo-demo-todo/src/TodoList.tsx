import { Todo, TodoProps } from "./Todo"

export const TodoList = () => {
  const todos = [
    { id: "1", content: "One", completed: false },
    { id: "2", content: "Two", completed: true },
    { id: "3", content: "Three", completed: false },
  ] as TodoProps[]

  return (
    <ul className="border-y divide-y divide-solid">
      {todos.map((todo) => (
        <Todo key={`todo-${todo.id}`} {...todo} />
      ))}
    </ul>
  )
}
