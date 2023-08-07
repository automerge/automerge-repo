import { useDocument } from "@automerge/automerge-repo-react-hooks"
import { AutomergeUrl } from "@automerge/automerge-repo"

interface Doc {
  count: number
}

export function App(props: { documentUrl: AutomergeUrl }) {
  const [doc, changeDoc] = useDocument<Doc>(props.documentUrl)

  return (
    <button
      onClick={() => {
        changeDoc((d: any) => {
          d.count = (d.count || 0) + 1
        })
      }}
    >
      Count: {doc?.count ?? 0}
    </button>
  )
}
