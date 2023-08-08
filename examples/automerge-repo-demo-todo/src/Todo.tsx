import { AutomergeUrl } from "@automerge/automerge-repo"
import { useDocument } from "@automerge/automerge-repo-react-hooks"
import cx from "classnames"
import { useEffect, useRef, useState } from "react"
import { Filter, TodoData } from "./types.js"

export const Todo = ({ url, onDestroy, filter }: TodoProps) => {
  const [todo, changeTodo] = useDocument<TodoData>(url)

  // editing mode
  const [editing, setEditing] = useState(false)

  // the content of the todo when editing
  const [content, setContent] = useState(todo?.content)

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
    setContent(todo?.content)
  }, [todo?.content])

  if (!todo) return null
  else if (filter === Filter.incomplete && todo.completed) return null
  else if (filter === Filter.completed && !todo.completed) return null
  else
    return (
      <li className="px-3 py-1 leading-none flex items-center group">
        {/* checkbox */}
        <input
          className="w-4 h-4 flex-none cursor-pointer"
          type="checkbox"
          checked={todo.completed}
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
          value={content}
          onFocus={e => setEditing(true)}
          onBlur={e => {
            const newContent = e.target.value.trim()
            if (newContent.length === 0) {
              // if user has removed all the content of the todo, delete it
              onDestroy(url)
            } else {
              // otherwise, update the content
              changeTodo(t => {
                t.content = newContent
              })
            }
            setEditing(false)
          }}
          onChange={e => setContent(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Escape") {
              // cancel & restore the original content
              setContent(todo.content)
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
          onClick={e => onDestroy(url)}
        />
      </li>
    )
}

export interface TodoProps {
  url: AutomergeUrl
  onDestroy: (id: AutomergeUrl) => void
  filter: Filter
}
