import { describe, expect, it } from "vitest"
import type { AnyDocumentId, DocHandle } from "@automerge/automerge-repo"
import { wrapperCache } from "../src/useDocHandle"
import { wrapPromise } from "../src/wrapPromise"
import {
  flushGC,
  gcAvailable,
  waitForGC,
} from "../../automerge-repo/src/helpers/tests/flushGC.js"

const itGC = gcAvailable ? it : it.skip

describe("wrapperCache lifetime", () => {
  const id = (s: string) => s as AnyDocumentId
  const fakeHandle = () => ({}) as DocHandle<unknown>

  it("shares one wrapper per id while the find is in flight", () => {
    const wrapper = wrapPromise(
      new Promise<DocHandle<unknown>>(() => {}) // never settles
    )
    wrapperCache.set(id("pending-doc"), wrapper)
    expect(wrapperCache.get(id("pending-doc"))).toBe(wrapper)
    wrapperCache.delete(id("pending-doc"))
  })

  itGC(
    "holds an in-flight wrapper strongly even with no other references",
    async () => {
      let probe!: WeakRef<object>
      ;(() => {
        const wrapper = wrapPromise(new Promise<DocHandle<unknown>>(() => {}))
        probe = new WeakRef(wrapper)
        wrapperCache.set(id("inflight-doc"), wrapper)
      })()

      await flushGC()
      expect(probe.deref()).toBeDefined()
      expect(wrapperCache.has(id("inflight-doc"))).toBe(true)
      wrapperCache.delete(id("inflight-doc"))
    }
  )

  // A named helper so no test-frame register can keep the wrapper alive.
  async function makeSettledWrapper(
    docId: AnyDocumentId
  ): Promise<WeakRef<object>> {
    const wrapper = wrapPromise(Promise.resolve(fakeHandle()))
    wrapperCache.set(docId, wrapper)
    await wrapper.promise
    return new WeakRef(wrapper)
  }

  itGC("releases a settled wrapper once nothing references it", async () => {
    const probe = await makeSettledWrapper(id("settled-doc"))

    expect(await waitForGC(probe)).toBe(true)
    expect(wrapperCache.has(id("settled-doc"))).toBe(false)
  })

  itGC(
    "keeps serving a settled wrapper while something references it",
    async () => {
      const wrapper = wrapPromise(Promise.resolve(fakeHandle()))
      wrapperCache.set(id("held-doc"), wrapper)
      await wrapper.promise

      await flushGC()
      expect(wrapperCache.get(id("held-doc"))).toBe(wrapper)
      wrapperCache.delete(id("held-doc"))
    }
  )
})
