import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WeakValueMap } from "../src/helpers/WeakValueMap.js"
import { kEntryCount } from "../src/internals.js"

/**
 * Registry bookkeeping against a substituted `WeakRef` and
 * `FinalizationRegistry`, so delivery is the test's decision rather than the
 * engine's. `WeakValueMap` reads both off the global object at construction
 * and at store time, so stubbing before construction is enough.
 */

/** A `WeakRef` whose referent the test decides when to drop. */
class FakeWeakRef<T extends object> {
  static instances: FakeWeakRef<object>[] = []

  constructor(private value: T | undefined) {
    FakeWeakRef.instances.push(this as FakeWeakRef<object>)
  }

  deref(): T | undefined {
    return this.value
  }

  static dropReferencesTo(target: object): void {
    for (const ref of FakeWeakRef.instances) {
      if (ref.deref() === target) ref.value = undefined
    }
  }
}

/** A `FinalizationRegistry` whose callbacks the test decides when to deliver. */
class FakeFinalizationRegistry<K> {
  static last: FakeFinalizationRegistry<unknown> | undefined
  readonly held = new Map<object, K>()

  constructor(private cleanup: (heldValue: K) => void) {
    FakeFinalizationRegistry.last = this as FakeFinalizationRegistry<unknown>
  }

  register(target: object, heldValue: K, token?: object): void {
    this.held.set(token ?? target, heldValue)
  }

  unregister(token: object): boolean {
    return this.held.delete(token)
  }

  /** Drop every reference to `target`, then deliver its cleanup callback if
   * one is still registered. */
  collect(target: object): boolean {
    FakeWeakRef.dropReferencesTo(target)
    const heldValue = this.held.get(target)
    if (heldValue === undefined) return false
    this.held.delete(target)
    this.cleanup(heldValue)
    return true
  }
}

const registry = () =>
  FakeFinalizationRegistry.last as FakeFinalizationRegistry<string>

describe("WeakValueMap registry bookkeeping", () => {
  beforeEach(() => {
    FakeWeakRef.instances = []
    vi.stubGlobal("WeakRef", FakeWeakRef)
    vi.stubGlobal("FinalizationRegistry", FakeFinalizationRegistry)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("registers the key as the held value and the value as the token", () => {
    const map = new WeakValueMap<string, object>()
    const value = { id: 1 }

    map.set("k", value)

    expect(registry().held.get(value)).toBe("k")
  })

  it("prunes the backing entry when the value is collected", () => {
    const map = new WeakValueMap<string, object>()
    const value = { id: 1 }
    map.set("k", value)
    expect(map[kEntryCount]).toBe(1)

    expect(registry().collect(value)).toBe(true)

    expect(map[kEntryCount]).toBe(0)
    expect(map.get("k")).toBeUndefined()
  })

  it("does not evict the value that replaced a collected one", () => {
    const map = new WeakValueMap<string, object>()
    const replaced = { id: 1 }
    const current = { id: 2 }
    map.set("k", replaced)
    map.set("k", current)

    expect(registry().collect(replaced)).toBe(false)

    expect(map.get("k")).toBe(current)
    expect(map[kEntryCount]).toBe(1)
  })

  it("unregisters on delete, so a later collection is inert", () => {
    const map = new WeakValueMap<string, object>()
    const value = { id: 1 }
    map.set("k", value)

    map.delete("k")

    expect(registry().collect(value)).toBe(false)
    expect(map[kEntryCount]).toBe(0)
  })
})
