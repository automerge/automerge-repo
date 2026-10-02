import * as A from "@automerge/automerge"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"

export function repoFragmentFixture() {
  let doc = A.init<{ count: number }>({ actor: "abcdef" })
  for (let count = 0; count < 2000; count++)
    doc = A.change(doc, { time: 0 }, d => {
      d.count = count
    })
  const records = extractRecords(doc)
  if (
    !records.some(r => r.kind === "fragment") ||
    !records.some(r => r.kind === "commit")
  )
    throw new Error("Fixture must exercise fragments and loose commits")
  return doc
}
