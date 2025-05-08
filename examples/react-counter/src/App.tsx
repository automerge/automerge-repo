import { AutomergeUrl, useDocument } from "@automerge/react"

interface Doc {
  count: number
}

export function App({ url }: { url: AutomergeUrl }) {
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
