// The Node diagnostic initializes both native runtimes before constructing a Repo.
// eslint-disable-next-line no-restricted-imports
import * as A from "@automerge/automerge"
import "@automerge/subduction"
// eslint-disable-next-line no-restricted-imports
import { Repo } from "@automerge/automerge-repo"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { DummySubductionStorageAdapter } from "@automerge/automerge-repo-subduction/helpers/DummySubductionStorageAdapter.js"
import { mkdir, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const cases = []
for (const changes of [1, 10, 51, 80]) {
  for (const documents of [1, 10]) {
    const store = new DummySubductionStorageAdapter()
    const counts = Object.fromEntries(
      [
        "loadMany",
        "loadPrefix",
        "list",
        "saveBatch",
        "removeBatch",
        "removeRange",
      ].map(op => [op, { calls: 0, ms: 0, values: 0 }])
    )
    const storage = Object.fromEntries(
      [
        "loadMany",
        "loadPrefix",
        "list",
        "saveBatch",
        "removeBatch",
        "removeRange",
      ].map(op => [
        op,
        async (...args) => {
          const started = performance.now()
          try {
            const result = await store[op](...args)
            if (op === "list") counts[op].values += result.length
            return result
          } finally {
            counts[op].calls++
            counts[op].ms += performance.now() - started
          }
        },
      ])
    )
    const backend = new SubductionBackend({ storage })
    const repo = new Repo({ backend })
    const started = performance.now()
    try {
      for (let i = 0; i < documents; i++) {
        let doc = A.change(
          A.init({ actor: (i + 1).toString(16).padStart(32, "0") }),
          { time: 0 },
          d => {
            d.count = 0
            d.items = Array(32).fill("initial")
          }
        )
        for (let j = 1; j < changes; j++)
          doc = A.change(doc, { time: 0 }, d => {
            d.count = j
            d.items[j % 32] = `revision-${j}`
          })
        await repo.import(A.save(doc))
      }
      await repo.flush()
    } finally {
      try {
        await repo.shutdown()
      } finally {
        await backend.close()
      }
    }
    const data = {
      documents,
      changes,
      totalMs: performance.now() - started,
      counts,
    }
    cases.push(data)
    console.log(
      `${documents} docs x ${changes} changes: ${data.totalMs.toFixed(1)}ms, ${counts.loadMany.calls + counts.loadPrefix.calls} loads, ${counts.list.calls} lists`
    )
  }
}
const directory = fileURLToPath(new URL("./results/", import.meta.url))
await mkdir(directory, { recursive: true })
await writeFile(
  join(directory, "seed-diagnosis.json"),
  JSON.stringify(
    { schema: 1, store: "DummySubductionStorageAdapter", cases },
    null,
    2
  ) + "\n"
)
