// Two-process controller + real-WASM durability smoke test; see README.
import * as A from "@automerge/automerge"
import { MemorySigner } from "@automerge/subduction"
import { strict as assert } from "node:assert"
import { idBytes, sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import { SedimentreeDocumentController } from "../../automerge-repo/src/SedimentreeDocumentController.js"
import { binaryToDocumentId } from "../../automerge-repo/src/AutomergeUrl.js"
import type { BinaryDocumentId } from "../../automerge-repo/src/types.js"
import { SubductionBackend } from "../src/index.js"
import { DiskStore } from "./storage.js"
import { fragmentFixture } from "./fragmentFixture.js"

const [mode, directory, history = "commits"] = process.argv.slice(2)
if (
  !directory ||
  !["write", "read"].includes(mode) ||
  !["commits", "fragments"].includes(history)
)
  throw new Error(
    "Usage: fresh-process.ts write|read <directory> [commits|fragments]"
  )
const signer = MemorySigner.fromBytes(new Uint8Array(32).fill(42))
const backend = new SubductionBackend({
  signer,
  storage: new DiskStore(directory),
  persistence: "persistent",
})
const id = sedimentreeId("57".repeat(16))
let writes = 0
const store = backend.store.bind(backend)
backend.store = (id, batch) => {
  writes++
  return store(id, batch)
}
const controller = new SedimentreeDocumentController<{ count: number }>({
  backend,
  id,
  documentId: binaryToDocumentId(idBytes(id) as BinaryDocumentId),
  initialDoc:
    mode === "write"
      ? history === "fragments"
        ? fragmentFixture()
        : A.change(
            A.init<{ count: number }>({ actor: "aabbcc" }),
            { time: 0 },
            d => {
              d.count = 0
            }
          )
      : undefined,
})
try {
  await controller.query.whenReady()
  assert.deepEqual(controller.handle.doc(), {
    count: history === "fragments" ? 1999 : 0,
  })
  assert.equal(
    A.getAllChanges(controller.document.doc).length,
    history === "fragments" ? 2000 : 1
  )
  await controller.flush()
  assert.equal(writes, mode === "write" ? 1 : 0)
} finally {
  try {
    await controller.close()
  } finally {
    await backend.close()
    signer.free()
  }
}
