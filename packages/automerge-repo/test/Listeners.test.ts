import { next as A } from "@automerge/automerge"
import { describe, expect, it } from "vitest"
import { generateAutomergeUrl, parseAutomergeUrl } from "../src/AutomergeUrl.js"
import { createTestDocument } from "./helpers/testHandle.js"

type Doc = { n: number }

/** A ready document, plus a view: a second handle that is not a sub-handle. */
const setup = () => {
  const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
  const { state, handle } = createTestDocument<Doc>(
    documentId,
    A.from<Doc>({ n: 0 })
  )
  const view = handle.view(handle.heads())
  const edit = () => handle.change(d => void d.n++)
  return { listeners: state.listeners, handle, view, edit }
}

describe("handle listeners", () => {
  it("counts, lists and names a handle's listeners", () => {
    const { handle } = setup()
    const first = () => {}
    const second = () => {}
    handle.on("change", first)
    handle.on("change", second)
    handle.on("delete", first)
    expect(handle.listenerCount("change")).toBe(2)
    expect(handle.listeners("change")).toEqual([first, second])
    expect(handle.eventNames()).toEqual(["change", "delete"])
    expect(handle.listenerCount("heads-changed")).toBe(0)
  })

  it("keeps listeners per handle", () => {
    const { handle, view } = setup()
    handle.on("delete", () => {})
    expect(view.listenerCount("delete")).toBe(0)
    expect(view.eventNames()).toEqual([])
  })

  it("removes one listener, or all for an event", () => {
    const { handle } = setup()
    const first = () => {}
    handle.on("change", first)
    handle.on("change", () => {})
    handle.on("delete", () => {})
    handle.off("change", first)
    expect(handle.listenerCount("change")).toBe(1)
    handle.off("change")
    expect(handle.listenerCount("change")).toBe(0)
    expect(handle.eventNames()).toEqual(["delete"])
    handle.removeAllListeners("delete")
    expect(handle.eventNames()).toEqual([])
  })

  it("runs a once() listener a single time", () => {
    const { handle, edit } = setup()
    let calls = 0
    handle.once("change", () => calls++)
    void edit()
    void edit()
    expect(calls).toBe(1)
    expect(handle.listenerCount("change")).toBe(0)
  })

  it("emits only to the handle's own listeners", () => {
    const { handle, view } = setup()
    const seen: string[] = []
    handle.on("delete", () => seen.push("handle"))
    view.on("delete", () => seen.push("view"))
    expect(handle.emit("delete", { handle })).toBe(true)
    expect(seen).toEqual(["handle"])
    expect(handle.emit("remote-heads", {} as any)).toBe(false)
  })

  it("keeps running listeners after one throws", () => {
    const { handle, edit } = setup()
    let calls = 0
    handle.on("change", () => {
      throw new Error("listener failed")
    })
    handle.on("change", () => calls++)
    void edit()
    expect(calls).toBe(1)
  })

  describe("retention", () => {
    it("retains a handle while it has listeners", () => {
      const { listeners, view } = setup()
      const baseline = listeners.retainedCount
      const callback = () => {}
      view.on("delete", callback)
      expect(listeners.retainedCount).toBe(baseline + 1)
      view.off("delete", callback)
      expect(listeners.retainedCount).toBe(baseline)
    })

    it("releases retention on removeAllListeners", () => {
      const { listeners, view } = setup()
      const baseline = listeners.retainedCount
      view.on("delete", () => {})
      view.on("remote-heads", () => {})
      expect(listeners.retainedCount).toBe(baseline + 1)
      view.removeAllListeners()
      expect(listeners.retainedCount).toBe(baseline)
    })

    it("releases retention after a once() listener fires", () => {
      const { listeners, handle, edit } = setup()
      const baseline = listeners.retainedCount
      handle.once("change", () => {})
      expect(listeners.retainedCount).toBe(baseline + 1)
      void edit()
      expect(listeners.retainedCount).toBe(baseline)
    })
  })
})
