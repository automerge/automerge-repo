import { Text } from "automerge-js"
import React, { useState } from "react"
import { RootDocument } from "../App"
import { useDocument, useHandle, useRepo } from "automerge-repo-react-hooks"
import { Editor } from "../prosemirror/Editor"

export interface TodoItemArgs {
  documentId: string
}

interface TodoItemDoc {
  text: Text
  done: boolean
}

function TodoItem({ documentId }: TodoItemArgs) {
  const [handle] = useHandle<TodoItemDoc>(documentId)
  const [doc, changeDoc] = useDocument<TodoItemDoc>(documentId)
  const toggleDone = () => {
    changeDoc((d: TodoItemDoc) => {
      d.done = !d.done
    })
  }
  if (!doc || !handle) {
    return <></>
  }
  const { done } = doc
  return (
    <div
      className={`
        flex border-b py-1 
        ${done ? "line-through text-gray-400" : ""}
      `}
    >
      {/* checkbox */}
      <input
        className="mr-2 mt-1 w-7 h-7 "
        type="checkbox"
        checked={done}
        onChange={toggleDone}
      ></input>

      {/* editable item*/}
      <div className="w-full">
        <Editor
          handle={handle}
          attribute={"text"}
          doc={doc}
          changeDoc={changeDoc}
        ></Editor>
      </div>
    </div>
  )
}

export interface TodoListArgs {
  documentId: string
}

export function TodoList({ documentId }: TodoListArgs) {
  const repo = useRepo()
  const [input, setInput] = useState("")
  const [doc, changeDoc] = useDocument<RootDocument>(documentId)

  const addItem = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    changeDoc((d) => {
      if (!d.items) {
        d.items = []
      }
      const newItem = repo.create<TodoItemDoc>()
      d.items.push(newItem.documentId)
      newItem.change((d: TodoItemDoc) => {
        d.text = new Text(input)
        d.done = false
      })
      setInput("")
    })
  }

  if (!doc) return null
  return (
    <div className="m-3 p-3 border w-96 border-blue-400 rounded-lg bg-white">
      <ul id="todo-list">
        {(doc.items || []).map((i) => (
          <TodoItem key={i} documentId={i} />
        ))}
      </ul>
      <form className="flex py-2" onSubmit={addItem}>
        {/* new item */}
        <input
          type="text"
          id="new-todo"
          placeholder="What needs to be done?"
          className="appearance-none rounded border border-blue-100 w-full px-3 py-1 text-grey-darker"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        {/* add button */}
        <input
          type="submit"
          className="rounded px-2 pv-1 ml-2 text-white bg-blue-500"
          value="Add"
        />
      </form>
    </div>
  )
}
