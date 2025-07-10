import { type PeerId, Repo, type DocHandle } from "@automerge/automerge-repo"

import { renderHook, testEffect } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import {
  createEffect,
  createRoot,
  createSignal,
  type ParentComponent,
} from "solid-js"
import makeDocumentProjection from "../src/makeDocumentProjection.js"
import { RepoContext } from "../src/context.js"

describe("makeDocumentProjection", () => {
  function setup() {
    const repo = new Repo({
      peerId: "bob" as PeerId,
    })

    const create = () =>
      repo.create<ExampleDoc>({
        key: "value",
        array: [1, 2, 3],
        hellos: [{ hello: "world" }, { hello: "hedgehog" }],
        projects: [
          { title: "one", items: [{ title: "go shopping" }] },
          { title: "two", items: [] },
        ],
      })

    const handle = create()
    const wrapper: ParentComponent = props => {
      return (
        <RepoContext.Provider value={repo}>
          {props.children}
        </RepoContext.Provider>
      )
    }

    return {
      repo,
      handle,
      wrapper,
      create,
    }
  }

  it("should notify on a property change", async () => {
    const { handle } = setup()
    const { result: doc, owner } = renderHook(
      makeDocumentProjection as (handle: DocHandle<ExampleDoc>) => ExampleDoc,
      {
        initialProps: [handle],
      }
    )

    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc.key).toBe("value")
          handle.change(doc => (doc.key = "hello world!"))
        } else if (run == 1) {
          expect(doc.key).toBe("hello world!")
          handle.change(doc => (doc.key = "friday night!"))
        } else if (run == 2) {
          expect(doc.key).toBe("friday night!")
          done()
        }
        return run + 1
      })
    }, owner!)
    return done
  })

  it("should not apply patches multiple times just because there are multiple projections of the same handle", async () => {
    const { handle } = setup()
    const { result: one, owner: owner1 } = renderHook(
      makeDocumentProjection as (handle: DocHandle<ExampleDoc>) => ExampleDoc,
      {
        initialProps: [handle],
      }
    )
    const { result: two, owner: owner2 } = renderHook(
      makeDocumentProjection as (handle: DocHandle<ExampleDoc>) => ExampleDoc,
      {
        initialProps: [handle],
      }
    )

    const done2 = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(two.array).toEqual([1, 2, 3])
        } else if (run == 1) {
          expect(two.array).toEqual([1, 2, 3, 4])
        } else if (run == 2) {
          expect(two.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    }, owner2!)

    const done1 = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(one.array).toEqual([1, 2, 3])
          handle.change(doc => doc.array.push(4))
        } else if (run == 1) {
          expect(one.array).toEqual([1, 2, 3, 4])
          handle.change(doc => doc.array.push(5))
        } else if (run == 2) {
          expect(one.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    }, owner1!)

    return Promise.allSettled([done1, done2])
  })

  it("should notify on a deep property change", async () => {
    const { handle } = setup()
    return createRoot(() => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      return testEffect(done => {
        createEffect((run: number = 0) => {
          if (run == 0) {
            expect(doc.projects[0].title).toBe("one")
            handle.change(doc => (doc.projects[0].title = "hello world!"))
          } else if (run == 1) {
            expect(doc.projects[0].title).toBe("hello world!")
            handle.change(doc => (doc.projects[0].title = "friday night!"))
          } else if (run == 2) {
            expect(doc.projects[0].title).toBe("friday night!")
            done()
          }
          return run + 1
        })
      })
    })
  })

  it("should not clean up when it should not clean up", async () => {
    const { handle } = setup()

    return createRoot(() => {
      const [one, clean1] = createRoot(c => [makeDocumentProjection(handle), c])
      const [two, clean2] = createRoot(c => [makeDocumentProjection(handle), c])
      const [three, clean3] = createRoot(c => [
        makeDocumentProjection(handle),
        c,
      ])
      const [signal, setSignal] = createSignal(0)
      return testEffect(done => {
        createEffect((run: number = 0) => {
          signal()
          expect(one.projects[0].title).not.toBeUndefined()
          expect(two.projects[0].title).not.toBeUndefined()
          expect(three.projects[0].title).not.toBeUndefined()

          if (run == 0) {
            // immediately clean up the first projection. updates should
            // carry on because there is still another reference
            clean1()
            expect(one.projects[0].title).toBe("one")
            expect(two.projects[0].title).toBe("one")
            expect(three.projects[0].title).toBe("one")
            handle.change(doc => (doc.projects[0].title = "hello world!"))
          } else if (run == 1) {
            // clean up another projection. updates should carry on
            // because there is still one left
            clean3()
            expect(one.projects[0].title).toBe("hello world!")
            expect(two.projects[0].title).toBe("hello world!")
            expect(three.projects[0].title).toBe("hello world!")
            setSignal(1)
          } else if (run == 2) {
            // now all the stores are cleaned up so further updates
            // should not show in the store
            clean2()
            setSignal(2)
          } else if (run == 3) {
            handle.change(doc => (doc.projects[0].title = "friday night!"))
            // force the test to run again
            setSignal(3)
          } else if (run == 4) {
            expect(one.projects[0].title).toBe("hello world!")
            expect(two.projects[0].title).toBe("hello world!")
            expect(three.projects[0].title).toBe("hello world!")
            done()
          }
          return run + 1
        })
      })
    })
  })

  it("should not notify on properties nobody cares about", async () => {
    const { handle } = setup()
    let fn = vi.fn()

    const { result: doc, owner } = renderHook(
      makeDocumentProjection as (handle: DocHandle<ExampleDoc>) => ExampleDoc,
      {
        initialProps: [handle],
      }
    )
    testEffect(() => {
      createEffect(() => {
        fn(doc?.projects[1].title)
      })
    })
    const arrayDotThree = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc.array[3]).toBeUndefined()

          handle.change(doc => (doc.array[2] = 22))

          handle.change(doc => (doc.key = "hello world!"))
          handle.change(doc => (doc.array[1] = 11))
          handle.change(doc => (doc.array[3] = 145))
        } else if (run == 1) {
          expect(doc?.array[3]).toBe(145)
          handle.change(doc => (doc.projects[0].title = "hello world!"))
          handle.change(
            doc => (doc.projects[0].items[0].title = "hello world!")
          )
          handle.change(doc => (doc.array[3] = 147))
        } else if (run == 2) {
          expect(doc?.array[3]).toBe(147)
          done()
        }
        return run + 1
      })
    }, owner!)
    const projectZeroItemZeroTitle = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc?.projects[0].items[0].title).toBe("hello world!")
          done()
        }
        return run + 1
      })
    }, owner!)

    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith("two")

    return Promise.all([arrayDotThree, projectZeroItemZeroTitle])
  })

  it("should remain reactive on an mount, unmount, and then remount of the same doc handle", async () => {
    const { handle } = setup()

    for (let i = 0; i < 2; ++i) {
      const [doc, clean] = createRoot(c => [makeDocumentProjection(handle), c])
      const lastRun = await testEffect<number>(done => {
        createEffect((run: number = 0) => {
          if (run == 0) {
            expect(doc.key).toBe("value")
            handle.change(doc => (doc.key = "hello world!"))
          } else if (run == 1) {
            expect(doc.key).toBe("hello world!")
            handle.change(doc => (doc.key = "friday night!"))
          } else if (run == 2) {
            expect(doc.key).toBe("friday night!")
            handle.change(doc => (doc.key = "value"))
            done(run)
          }
          return run + 1
        })
      })
      expect(lastRun).toBe(2)
      clean()
    }
  })
})

interface ExampleDoc {
  key: string
  array: number[]
  hellos: { hello: string }[]
  projects: {
    title: string
    items: { title: string; complete?: number }[]
  }[]
}
