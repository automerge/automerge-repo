import { describe, expect, it } from "vitest"
import { semaphore } from "../src/helpers/semaphore.js"

// Drain all pending microtasks by bouncing off a macrotask.
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

describe("semaphore", () => {
  it("runs free-slot tasks synchronously and defers only the over-capacity ones", () => {
    // Pins the synchronous-start contract: a free slot must invoke `fn` in the
    // current tick (callers like Repo.flush unblock a paused test double right
    // after starting the work). An `await` before `fn` (e.g. `await acquire()`)
    // would defer it to a microtask: this test would then see `[]` here. A
    // missing gate would see `[0, 1, 2]`. Only `[0, 1]` is correct.
    const limit = semaphore(2)
    const startedSync: number[] = []
    const holdSlotOpen = () => new Promise<void>(() => {})
    void limit(() => {
      startedSync.push(0)
      return holdSlotOpen()
    })
    void limit(() => {
      startedSync.push(1)
      return holdSlotOpen()
    })
    void limit(() => {
      startedSync.push(2) // over capacity — must not run in this tick
      return holdSlotOpen()
    })
    expect(startedSync).toEqual([0, 1])
  })

  it("runs at most `concurrency` tasks at once and starts queued tasks as slots free", async () => {
    const limit = semaphore(2)
    const started: number[] = []
    const resolvers: Array<() => void> = []
    const make = (i: number) =>
      limit(() => {
        started.push(i)
        return new Promise<void>(resolve => {
          resolvers[i] = resolve
        })
      })

    const all = Promise.all([make(0), make(1), make(2), make(3)])

    await flush()
    expect(started).toEqual([0, 1]) // only two slots

    resolvers[0]()
    await flush()
    expect(started).toEqual([0, 1, 2]) // a freed slot admits the next

    resolvers[1]()
    await flush()
    expect(started).toEqual([0, 1, 2, 3])

    resolvers[2]()
    resolvers[3]()
    await all
  })

  it("resolves results in input order regardless of completion order", async () => {
    const limit = semaphore(3)
    const results = await Promise.all(
      [30, 10, 20].map((ms, i) =>
        limit(
          () => new Promise<number>(resolve => setTimeout(() => resolve(i), ms))
        )
      )
    )
    expect(results).toEqual([0, 1, 2])
  })

  it("releases the slot when a task rejects so the queue keeps draining", async () => {
    const limit = semaphore(1)
    let bRan = false
    const a = limit(() => Promise.reject(new Error("boom")))
    const b = limit(() => {
      bRan = true
    })
    // If a rejection did not free the slot, `b` would never run and the await
    // below would hang the test.
    await expect(a).rejects.toThrow("boom")
    await b
    expect(bRan).toBe(true)
  })

  it("rejects an invalid concurrency", () => {
    expect(() => semaphore(0)).toThrow(TypeError)
    expect(() => semaphore(-1)).toThrow(TypeError)
    expect(() => semaphore(1.5)).toThrow(TypeError)
  })
})
