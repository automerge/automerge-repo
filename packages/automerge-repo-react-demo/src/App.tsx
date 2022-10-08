import { DocumentId } from "automerge-repo"
import React from "react"
import "./App.css"
import { TodoList } from "./components/TodoList"

export interface RootDocument {
  items: DocumentId[]
}

interface AppArgs {
  rootDocumentId: DocumentId
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
