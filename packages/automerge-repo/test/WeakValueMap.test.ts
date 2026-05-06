import { describe, expect, it } from "vitest"
import { WeakValueMap } from "../src/helpers/WeakValueMap.js"
import { flushGC, gcAvailable } from "./helpers/flushGC.js"

const itGC = gcAvailable ? it : it.skip

class Box {
  constructor(public n: number) {}
}

describe("WeakValueMap — synchronous behavior", () => {
  it("set/get round-trips with string keys", () => {
    const m = new WeakValueMap<string, Box>()
    const v = new Box(1)
    m.set("a", v)
    expect(m.get("a")).toBe(v)
    expect(m.has("a")).toBe(true)
  })

  it("set/get round-trips with number keys", () => {
    const m = new WeakValueMap<number, Box>()
    const v = new Box(2)
    m.set(42, v)
    expect(m.get(42)).toBe(v)
  })

  it("get returns undefined for missing keys", () => {
    const m = new WeakValueMap<string, Box>()
    expect(m.get("missing")).toBeUndefined()
    expect(m.has("missing")).toBe(false)
  })

  it("delete removes the entry", () => {
    const m = new WeakValueMap<string, Box>()
    const v = new Box(3)
    m.set("a", v)
    expect(m.delete("a")).toBe(true)
    expect(m.get("a")).toBeUndefined()
    expect(m.delete("a")).toBe(false)
  })

  it("set overwrites with the new value", () => {
    const m = new WeakValueMap<string, Box>()
    const v1 = new Box(1)
    const v2 = new Box(2)
    m.set("a", v1)
    m.set("a", v2)
    expect(m.get("a")).toBe(v2)
  })

  it("getOrCompute calls the factory only on miss", () => {
    const m = new WeakValueMap<string, Box>()
    let calls = 0
    const factory = () => {
      calls++
      return new Box(7)
    }
    const a = m.getOrCompute("k", factory)
    const b = m.getOrCompute("k", factory)
    expect(a).toBe(b)
    expect(calls).toBe(1)
  })
})

describe("WeakValueMap — GC behavior", () => {
  itGC("evicts the entry once the value is collected", async () => {
    const m = new WeakValueMap<string, Box>()
    let probe!: WeakRef<Box>

      // Scope the strong reference to an inner block so it doesn't pin the
      // value via the test stack frame.
    ;(() => {
      const v = new Box(1)
      m.set("k", v)
      probe = new WeakRef(v)
    })()

    await flushGC()

    expect(probe.deref()).toBeUndefined()
    expect(m.get("k")).toBeUndefined()
    // Observable proof the entry is gone: the factory runs again.
    let factoryCalled = false
    const fresh = m.getOrCompute("k", () => {
      factoryCalled = true
      return new Box(2)
    })
    expect(factoryCalled).toBe(true)
    expect(fresh).toBeInstanceOf(Box)
  })

  itGC("retains the entry while the value is still referenced", async () => {
    const m = new WeakValueMap<string, Box>()
    const kept = new Box(1)
    m.set("k", kept)

    await flushGC()

    expect(m.get("k")).toBe(kept)
  })

  itGC("overwrite unregisters the previous value's finalizer", async () => {
    // If set() did not unregister the previous value's token, then once
    // v1 is collected its finalizer would delete the "k" entry — even
    // though v2 is still alive.
    const m = new WeakValueMap<string, Box>()
    const v2 = new Box(2)

    ;(() => {
      const v1 = new Box(1)
      m.set("k", v1)
      m.set("k", v2)
    })()

    await flushGC()

    expect(m.get("k")).toBe(v2)
  })

  itGC("evicts many entries when all values are dropped", async () => {
    const m = new WeakValueMap<number, Box>()
    const probes: WeakRef<Box>[] = []

    ;(() => {
      for (let i = 0; i < 1000; i++) {
        const v = new Box(i)
        m.set(i, v)
        probes.push(new WeakRef(v))
      }
    })()

    await flushGC()

    const alive = probes.filter(r => r.deref() !== undefined).length
    expect(alive).toBe(0)
    // Observable proof keys are gone: factory runs for every key.
    let factoryCalls = 0
    for (let i = 0; i < 1000; i++) {
      m.getOrCompute(i, () => {
        factoryCalls++
        return new Box(-1)
      })
    }
    expect(factoryCalls).toBe(1000)
  })
})
