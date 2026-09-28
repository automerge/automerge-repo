import * as A from "@automerge/automerge"
import { extractRecords } from "@automerge/automerge-repo/sedimentree/automerge"

/** Stable history with both loose commits and bundled fragments. */
export function fragmentFixture() {
  let doc = A.init<{ count: number }>({ actor: "abcdef" })
  for (let n = 0; n < 2000; n++)
    doc = A.change(doc, { time: 0 }, d => {
      d.count = n
    })
  const records = extractRecords(doc)
  if (
    !records.some(r => r.kind === "fragment") ||
    !records.some(r => r.kind === "commit")
  )
    throw new Error("Fixture must exercise both record kinds")
  return doc
}
