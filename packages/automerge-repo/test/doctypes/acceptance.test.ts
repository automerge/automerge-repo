import { next as A } from "@automerge/automerge"
import { automerge } from "../../src/automerge/docType.js"
import { runDocTypeTests } from "../../src/helpers/tests/doc-type-tests.js"
import { add, gcounter, newCounter } from "./gcounter.js"

type Doc = { n: number }

runDocTypeTests("automerge", () => ({
  type: automerge,
  create: () => A.from<Doc>({ n: 0 }),
  change: doc => A.change(doc, (d: Doc) => void d.n++),
  init: { n: 0 },
  edit: handle => handle.change((d: Doc) => void d.n++),
}))

runDocTypeTests("gcounter", () => ({
  type: gcounter,
  create: () => newCounter(1),
  change: state => add(state, 1),
  init: 1,
  edit: handle => handle.increment(),
}))
