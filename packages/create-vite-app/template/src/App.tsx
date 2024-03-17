import reactLogo from "./assets/react.svg"
import viteLogo from "/vite.svg"
import automergeLogo from "./assets/automerge.png"
import "./App.css"
import { AutomergeUrl } from "@automerge/automerge-repo"
import { useDocument } from "@automerge/automerge-repo-react-hooks"
import { next as A } from "@automerge/automerge"

interface CounterDoc {
  counter: A.Counter
}

function App({ docUrl }: { docUrl: AutomergeUrl }) {
  const [doc, changeDoc] = useDocument<CounterDoc>(docUrl)

  return (
    <>
      <div>
        <a href="automerge.org" target="_blank">
          <img src={automergeLogo} className="logo" alt="Automerge logo" />
        </a>
        <a href="https://vitejs.dev" target="_blank">
          <img src={viteLogo} className="logo" alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className="logo react" alt="React logo" />
        </a>
      </div>
      <h1>Automerge + Vite + React</h1>
      <div className="card">
        <button onClick={() => changeDoc(d => d.counter.increment(1))}>
          count is {doc && doc.counter.value}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <p className="read-the-docs">
        Click on the Vite and React logos to learn more
      </p>
    </>
  )
}

export default App
