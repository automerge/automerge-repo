import {
  useBootstrap,
  useDocument,
} from "@automerge/automerge-repo-react-hooks"

interface Doc {
  count: number
}

export function App() {
  const { url } = useBootstrap({
    onNoDocument: repo => {
      const handle = repo.create<Doc>()
      handle.change(d => {
        d.count = 0
      })
      return handle
    },
  })
  const [doc, changeDoc] = useDocument<Doc>(url)

  if (!doc) {
    return null
  }

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
