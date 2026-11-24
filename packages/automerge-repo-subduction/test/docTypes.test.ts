// Fullfat initializes the native runtime borrowed by the backend's slim import.
import "@automerge/subduction"
import { next as A } from "@automerge/automerge"
import { describe, expect, it, vi } from "vitest"
import { Repo } from "../../automerge-repo/src/Repo.js"
import { Presence } from "../../automerge-repo/src/presence/Presence.js"
import { automerge } from "../../automerge-repo/src/automerge/docType.js"
// The acceptance suite and the G-Counter live in the core package's sources;
// neither is exported.
import { runDocTypeTests } from "../../automerge-repo/src/helpers/tests/doc-type-tests.js"
import {
  add,
  gcounter,
  newCounter,
} from "../../automerge-repo/test/doctypes/gcounter/gcounter.js"
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

describe("gcounter with Subduction backend extensions", () => {
  it("exchanges ephemeral messages and Presence over a G-Counter and its view", async () => {
    const aBackend = new SubductionBackend({
      storage: new DummySubductionStorageAdapter(),
      syncTimeoutMilliseconds: 1000,
    })
    const bBackend = new SubductionBackend({
      storage: new DummySubductionStorageAdapter(),
      network: [new LinkedAdapter(aBackend)],
      syncTimeoutMilliseconds: 1000,
    })
    const a = new Repo({ backend: aBackend as any })
    const b = new Repo({ backend: bBackend as any })
    try {
      const counterA = await a.create(1, { type: gcounter })
      await a.flush()
      const counterB = await b.find(counterA.url, { type: gcounter })
      const viewB = counterB.view(counterB.heads())

      const received: unknown[] = []
      const receivedOnView: unknown[] = []
      ;(counterB as any).on("ephemeral-message", (p: any) =>
        received.push(p.message)
      )
      ;(viewB as any).on("ephemeral-message", (p: any) =>
        receivedOnView.push(p.message)
      )
      ;(counterA as any).broadcast({ ping: 42 })

      await vi.waitFor(
        () => {
          expect(received).toContainEqual({ ping: 42 })
          expect(receivedOnView).toContainEqual({ ping: 42 })
        },
        { timeout: 5000, interval: 10 }
      )

      const presenceA = new Presence({ handle: counterA as any })
      const presenceB = new Presence({ handle: counterB as any })
      presenceA.start({ initialState: { cursor: 7 } })
      presenceB.start({ initialState: { cursor: 9 } })
      try {
        await vi.waitFor(
          () => {
            expect(presenceB.getPeerStates().value[a.id]?.value).toEqual({
              cursor: 7,
            })
            expect(presenceA.getPeerStates().value[b.id]?.value).toEqual({
              cursor: 9,
            })
          },
          { timeout: 5000, interval: 10 }
        )
      } finally {
        presenceA.stop()
        presenceB.stop()
      }
    } finally {
      await Promise.allSettled([a.shutdown(), b.shutdown()])
    }
  })
})
