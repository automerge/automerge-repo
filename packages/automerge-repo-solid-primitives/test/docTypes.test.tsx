import { automerge, Repo } from "@automerge/automerge-repo"
import { testEffect } from "@solidjs/testing-library"
import { createEffect } from "solid-js"
import { describe, expect, it } from "vitest"
import { createRepoPrimitives } from "../src/createRepoPrimitives.js"
import useDocHandle from "../src/useDocHandle.js"
import useDocSignal from "../src/useDocSignal.js"
import useDocument from "../src/useDocument.js"
import { counter, CounterHandle } from "./counter.js"

async function setup() {
  const repo = new Repo()
  const handle = await repo.create(0, { docType: counter })
  return { repo, handle }
}

describe("doc types", () => {
  it("useDocHandle opens a document of the given doc type", async () => {
    const { repo, handle } = await setup()
    const found = useDocHandle(handle.url, { repo, docType: counter })
    expect(found()).toBe(handle)
    expect(found()).toBeInstanceOf(CounterHandle)
  })

  it("useDocHandle finds a document of the given doc type", async () => {
    const { repo, handle } = await setup()
    await repo.removeFromCache(handle.documentId)
    await testEffect(done => {
      const found = useDocHandle(handle.url, { repo, docType: counter })
      createEffect(() => {
        if (found()) {
          expect(found()?.doc()).toBe(0)
          done()
        }
      })
    })
  })

  for (const [name, use] of [
    ["useDocument", useDocument],
    ["useDocSignal", useDocSignal],
  ] as const)
    it(`${name} follows a document of the given doc type`, async () => {
      const { repo, handle } = await setup()
      await testEffect(done => {
        const [value, found] = use(handle.url, { repo, docType: counter })
        createEffect((run: number = 0) => {
          if (run == 0) {
            expect(value()).toBe(0)
            void found()?.increment(2)
          } else if (run == 1) {
            expect(value()).toBe(2)
            done()
          }
          return run + 1
        })
      })
    })

  it("useDocument with automerge.of<T>() is fine-grained", async () => {
    const { repo } = await setup()
    const doc = await repo.create({ a: 1, b: 1 })
    await testEffect(done => {
      const [value, found] = useDocument(doc.url, {
        repo,
        docType: automerge.of<{ a: number; b: number }>(),
      })
      createEffect((run: number = 0) => {
        // Reads only `a`, so a change to `b` alone does not rerun it.
        const a = value()?.a
        if (run == 0) {
          expect(a).toBe(1)
          void found()?.change(d => void (d.b = 2))
          void found()?.change(d => void (d.a = 2))
        } else if (run == 1) {
          expect(a).toBe(2)
          expect(value()?.b).toBe(2)
          done()
        }
        return run + 1
      })
    })
  })

  it("createRepoPrimitives passes the doc type on", async () => {
    const { repo, handle } = await setup()
    const primitives = createRepoPrimitives(repo)
    await testEffect(done => {
      // The factory's primitives need its provider.
      primitives.RepoProvider({
        value: repo,
        get children() {
          const [value, found] = primitives.useDocument(handle.url, {
            docType: counter,
          })
          createEffect(() => {
            expect(found()).toBe(handle)
            expect(value()).toBe(0)
            done()
          })
          return undefined
        },
      })
    })
  })
})
