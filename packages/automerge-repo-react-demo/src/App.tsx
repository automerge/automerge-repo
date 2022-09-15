import React from "react"
import "./App.css"
import { TodoList } from "./components/TodoList"

export interface RootDocument {
  items: string[]
}

interface AppArgs {
  rootDocumentId: string
}

function App({ rootDocumentId }: AppArgs) {
  return (
    <div className="App">
      <header className="App-header">
        <TodoList documentId={rootDocumentId} />
      </header>
    </div>
  )
}

export default App
