import { useRef, useState, useEffect } from "react"
import cn from "classnames"

const ENTER_KEY = 13
const ESCAPE_KEY = 27

export const Todo = ({ id, completed, content }: TodoProps) => {
  // const dispatch = useDispatch()

  // component state
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(content)

  // input.current will contain a reference to the editing input
  const input = useRef()

  // side effect: need to select all content in the input when going into editing mode
  // this will only fire when `editing` changes
  const selectAllOnEdit = () => {
    // if (editing) input.current.select()
  }
  useEffect(selectAllOnEdit, [editing])

  // we save when the user has either tabbed or clicked away, or hit Enter
  const save = (e: any) => {
    const saveContent = e.target.value.trim()
    if (saveContent.length > 0) {
      // todo was changed - keep the edited content
      // dispatch(editTodo(id, saveContent))
    } else {
      // user has removed all the content of the todo, so delete it
      // dispatch(destroyTodo(id))
    }
    leaveEditMode()
  }

  // listen for special keys
  const onKeyDown = (e: any) => {
    if (e.keyCode === ESCAPE_KEY) {
      // ESC: abort editing
      restoreContent()
      leaveEditMode()
    } else if (e.keyCode === ENTER_KEY) {
      // ENTER: persist the edited content
      save(e)
    }
  }

  const enterEditMode = () => setEditing(true)
  const leaveEditMode = () => setEditing(false)

  const updateContent = (e: any) => setEditContent(e.target.value)
  const restoreContent = () => setEditContent(content)

  return (
    <li className={cn({ completed, editing })}>
      <div className="view">
        <input
          className="toggle"
          type="checkbox"
          checked={completed}
          // onChange={() => dispatch(toggleTodo(id))}
        />
        <label onDoubleClick={enterEditMode}>{content}</label>
        <button
          className="destroy"
          style={{ cursor: "pointer" }}
          // onClick={() => dispatch(destroyTodo(id))}
        />
      </div>

      <input
        className="edit"
        // ref={input}
        value={editContent}
        onBlur={save}
        onChange={updateContent}
        onKeyDown={onKeyDown}
      />
    </li>
  )
}

export interface TodoProps {
  id: string
  completed: boolean
  content: string
}
