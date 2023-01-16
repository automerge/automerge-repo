import { DocumentId } from "automerge-repo"
import cx from "classnames"
import { useEffect, useRef, useState } from "react"
import { TodoData } from "./dataModel"

export const Todo = ({ todo, onToggle, onEdit, onDestroy }: TodoProps) => {
  const { id, content, completed } = todo

  // editing mode
  const [editing, setEditing] = useState(false)

  // the content of the todo when editing
  const [newContent, setNewContent] = useState(content)

  // the input element for editing the todo content
  const contentInput = useRef<HTMLInputElement>(null)

  // handle entering and exiting edit mode
  useEffect(() => {
    if (!contentInput.current) return

    // select all content in the input when going into editing mode
    if (editing) {
      contentInput.current.select()
    }
    // blur when leaving editing mode
    else {
      contentInput.current.blur()
    }
  }, [editing])

  // update the input when the content of the todo is modified from elsewhere
  useEffect(() => {
    setNewContent(content)
  }, [content])

  return (
    <li className="px-3 py-1 leading-none flex items-center group">
      {/* checkbox */}
      <input
        className="w-4 h-4 flex-none cursor-pointer"
        type="checkbox"
        checked={completed}
        onChange={e => onToggle(id)}
      />
      {/* todo content */}
      <input
        className="flex-1 mx-1 p-1"
        ref={contentInput}
        value={newContent}
        onFocus={e => setEditing(true)}
        onBlur={e => {
          const newContent = e.target.value.trim()
          if (newContent.length > 0) {
            // todo was changed - keep the edited content
            onEdit(id, newContent)
          } else {
            // user has removed all the content of the todo, so delete it
            onDestroy(id)
          }
          setEditing(false)
        }}
        onChange={e => setNewContent(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") {
            // restore the original content
            setNewContent(content)
            setEditing(false)
          } else if (e.key === "Enter") {
            setEditing(false)
          }
        }}
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
        onClick={e => onDestroy(id)}
      />
    </li>
  )
}

export interface TodoProps {
  todo: TodoData
  onToggle: (id: DocumentId) => void
  onEdit: (id: DocumentId, content: string) => void
  onDestroy: (id: DocumentId) => void
}
