// Fullfat initializes the native runtime borrowed by the backend's slim import.
import "@automerge/subduction"
import { next as A } from "@automerge/automerge"
import { automerge } from "../../automerge-repo/src/automerge/docType.js"
// The acceptance suite and the G-Counter live in the core package's sources;
// neither is exported.
import { runDocTypeTests } from "../../automerge-repo/src/helpers/tests/doc-type-tests.js"
import {
  add,
  gcounter,
  newCounter,
} from "../../automerge-repo/test/doctypes/gcounter.js"
import { SubductionBackend } from "../src/index.js"
import { DummySubductionStorageAdapter } from "../src/helpers/DummySubductionStorageAdapter.js"
import { LinkedAdapter } from "./linkedAdapter.js"

/** Two Repos' backends, the second connected to the first. */
const backends = () => {
  const backend = (network?: LinkedAdapter[]) =>
    new SubductionBackend({
      storage: new DummySubductionStorageAdapter(),
      network,
      syncTimeoutMilliseconds: 1000,
    })
  const a = backend()
  // The suite's types come from the core package's sources, the backend's
  // from its build.
  return { a, b: backend([new LinkedAdapter(a)]) } as any
}

type Doc = { n: number }

runDocTypeTests("automerge over Subduction", () => ({
  type: automerge,
  create: () => A.from<Doc>({ n: 0 }),
  change: doc => A.change(doc, (d: Doc) => void d.n++),
  init: { n: 0 },
  edit: handle => handle.change((d: Doc) => void d.n++),
  backends,
}))

runDocTypeTests("gcounter over Subduction", () => ({
  type: gcounter,
  create: () => newCounter(1),
  change: state => add(state, 1),
  init: 1,
  edit: handle => handle.increment(),
  backends,
}))
