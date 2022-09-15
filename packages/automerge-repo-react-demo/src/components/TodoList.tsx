import { Text } from "automerge-js"
import React, { useState } from "react"
import { RootDocument } from "../App"
import { useDocument, useHandle, useRepo } from "../hooks"
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
      style={
        done
          ? { display: "flex", textDecoration: "line-through" }
          : { display: "flex" }
      }
    >
      <input
        type="checkbox"
        defaultChecked={done}
        onChange={toggleDone}
      ></input>
      <Editor
        handle={handle}
        attribute={"text"}
        doc={doc}
        changeDoc={changeDoc}
      ></Editor>
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

  if (!doc) {
    return <></>
  }

  const items = (doc.items || []).map((i) => (
    <TodoItem key={i} documentId={i} />
  ))

  return (
    <>
      <ul id="todo-list">{items}</ul>
      <form onSubmit={addItem}>
        <input
          type="text"
          id="new-todo"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <input type="submit" value=">" />
      </form>
    </>
  )
}
