import { useRef } from "react"

export const AddTodo = () => {
  // input.current will contain a reference to the new todo input field
  const input = useRef(null)

  // const dispatch = useDispatch()

  const save = (e: any) => {
    // don't post back
    e.preventDefault()
    // const newText = input.current.value.trim()
    // don't create empty todos
    // if (newText.length === 0) return
    // update state with new todo
    // dispatch(addTodo(newText))
    // clear input
    // input.current.value = ""
  }

  return (
    <>
      <form onSubmit={save}>
        <input
          className="w-full p-3 rounded-md"
          placeholder="Add a new todo"
          // ref={input}
          autoFocus={true}
        />
      </form>
    </>
  )
}
