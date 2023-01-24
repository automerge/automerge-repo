import { DocumentId } from "automerge-repo"
import { useDocument, useRepo } from "automerge-repo-react-hooks"
import cx from "classnames"
import { useEffect, useRef, useState } from "react"
import { Filter, TodoData } from "./types.js"

export const Todo = ({ documentId, onDestroy, filter }: TodoProps) => {
  const [todo, changeTodo] = useDocument<TodoData>(documentId)

  // for reasons I don't understand, the todo is always undefined for a couple of cycles

  // we'd love to just bail, but hooks can't be called conditionally
  //  if (!todo) return null // 🡐 not allowed because we have more hooks further down

  // so we have to do this ridiculousness
  const {
    id = "" as DocumentId, //
    content = "",
    completed = false,
  } = todo ?? {}

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
    if (editing) contentInput.current.select()

    // blur when leaving editing mode
    if (!editing) contentInput.current.blur()
  }, [editing])

  // update the input when the content of the todo is modified from elsewhere
  useEffect(() => {
    setNewContent(content)
  }, [content])

  // now we can bail, because we've already set up all the hooks
  if (!todo) return null

  // if the todo is not in the current filter, don't render it
  if (filter === Filter.incomplete && completed) return null
  if (filter === Filter.completed && !completed) return null

  return (
    <li className="px-3 py-1 leading-none flex items-center group">
      {/* checkbox */}
      <input
        className="w-4 h-4 flex-none cursor-pointer"
        type="checkbox"
        checked={completed}
        onChange={e => {
          changeTodo(t => {
            t.completed = !t.completed
          })
        }}
      />

      {/* todo content */}
      <input
        className="flex-1 mx-1 p-1"
        ref={contentInput}
        value={newContent}
        onFocus={e => setEditing(true)}
        onBlur={e => {
          const newContent = e.target.value.trim()

          // if user has removed all the content of the todo, delete it
          if (newContent.length === 0) {
            onDestroy(id)
          }
          // otherwise, update the content
          else {
            changeTodo(t => {
              t.content = newContent
            })
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
  documentId: DocumentId
  onDestroy: (id: DocumentId) => void
  filter: Filter
}
