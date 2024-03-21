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
        <a href="https://automerge.org" target="_blank">
          <img src={automergeLogo} className="logo" alt="Vite logo" />
        </a>
      </div>
      <h1>Meet Automerge</h1>
      <div className="card">
        <button onClick={() => changeDoc(d => d.counter.increment(1))}>
          count is {doc && doc.counter.value}
        </button>
        <p>Open this page in another tab to watch the updates synchronize</p>
      </div>
      <p className="read-the-docs">
        Built with Automerge, Vite, React, and TypeScript
      </p>
    </>
  )
}

export default App
