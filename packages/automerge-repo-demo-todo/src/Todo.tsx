import { useRef, useState, useEffect } from "react"
import cx from "classnames"
import { TodoData } from "./dataModel"

const ENTER_KEY = 13
const ESCAPE_KEY = 27

export const Todo = ({ todo, onToggle, onEdit, onDestroy }: TodoProps) => {
  const { id, content, completed } = todo
  // const dispatch = useDispatch()

  // component state
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(content)

  // input.current will contain a reference to the editing input
  const input = useRef(null)

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
      onEdit(id, saveContent)
    } else {
      // user has removed all the content of the todo, so delete it
      onDestroy(id)
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
    <li className="px-3 py-1 leading-none flex items-center group">
      {/* checkbox */}
      <input
        className="w-4 h-4 flex-none cursor-pointer"
        type="checkbox"
        checked={completed}
        onChange={() => onToggle(id)}
      />
      {/* todo content */}
      <input
        className="flex-1 mx-1 p-1"
        ref={input}
        value={editContent}
        onFocus={enterEditMode}
        onBlur={save}
        onChange={updateContent}
        onKeyDown={onKeyDown}
      />
      {/* delete button */}
      <button
        className={cx(
          "p-1",
          "opacity-5 group-hover:opacity-100 focus:opacity-100 ",
          "transition-opacity duration-300",
          "after:content-['⨉']",
          "font-extrabold text-danger-500"
        )}
        style={{ cursor: "pointer" }}
        onClick={() => onDestroy(id)}
      />
    </li>
  )
}

export interface TodoProps {
  todo: TodoData
  onToggle: (id: string) => void
  onEdit: (id: string, content: string) => void
  onDestroy: (id: string) => void
}
