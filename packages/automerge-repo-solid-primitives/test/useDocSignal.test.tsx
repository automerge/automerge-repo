import { type PeerId, Repo, type AutomergeUrl } from "@automerge/automerge-repo"
import { renderHook, testEffect } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import { createEffect, createSignal, type ParentComponent } from "solid-js"
import useDocSignal from "../src/useDocSignal.js"

interface ExampleDoc {
  key: string
  array: number[]
  nested: { title: string }
}

describe("useDocSignal", () => {
  function setup() {
    const repo = new Repo({
      peerId: "bob" as PeerId,
    })

    const create = () =>
      repo.create<ExampleDoc>({
        key: "value",
        array: [1, 2, 3],
        nested: { title: "hello" },
      })

    const wrapper: ParentComponent = props => {
      return (
        <RepoContext.Provider value={repo}>
          {props.children}
        </RepoContext.Provider>
      )
    }

    return {
      repo,
      wrapper,
      create,
      options: { repo },
    }
  }

  it("should return the initial document value", async () => {
    const { create, options } = setup()

    await testEffect(done => {
      const [doc] = useDocSignal<ExampleDoc>(create().url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          done()
        }
        return run + 1
      })
    })
  })

  it("should notify on a property change", async () => {
    const { create, options } = setup()

    await testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(create().url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          handle()?.change(doc => (doc.key = "hello world!"))
        } else if (run == 1) {
          expect(doc()?.key).toBe("hello world!")
          handle()?.change(doc => (doc.key = "friday night!"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("friday night!")
          done()
        }
        return run + 1
      })
    })
  })

  it("should return the handle as the second element", async () => {
    const { create, options } = setup()
    const created = create()

    await testEffect(done => {
      const [, handle] = useDocSignal<ExampleDoc>(created.url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(handle()).not.toBe(undefined)
          expect(handle()?.url).toBe(created.url)
          done()
        }
        return run + 1
      })
    })
  })

  it("should update when an array element changes", async () => {
    const { create, options } = setup()

    await testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(create().url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.array).toEqual([1, 2, 3])
          handle()?.change(doc => doc.array.push(4))
        } else if (run == 1) {
          expect(doc()?.array).toEqual([1, 2, 3, 4])
          done()
        }
        return run + 1
      })
    })
  })

  it("should update when a nested property changes", async () => {
    const { create, options } = setup()

    await testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(create().url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.nested.title).toBe("hello")
          handle()?.change(doc => (doc.nested.title = "world"))
        } else if (run == 1) {
          expect(doc()?.nested.title).toBe("world")
          done()
        }
        return run + 1
      })
    })
  })

  it("should work with a signal url", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()
    const {
      result: [doc, handle],
      owner,
    } = renderHook(useDocSignal<ExampleDoc>, {
      initialProps: [url],
      wrapper,
    })

    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()).toBeUndefined()
          setURL(create().url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          handle()?.change(doc => (doc.key = "hello world!"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("hello world!")
          setURL(create().url)
        } else if (run == 3) {
          expect(doc()?.key).toBe("value")
          done()
        }
        return run + 1
      })
    }, owner!)
    return done
  })

  it("should clear the signal when the url returns to nothing", async () => {
    const { create, options } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()

    const done = testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(handle()).toBe(undefined)
          setURL(create().url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          expect(handle()).not.toBe(undefined)
          setURL(undefined)
        } else if (run == 2) {
          expect(handle()).toBe(undefined)
          setURL(create().url)
        } else if (run == 3) {
          expect(doc()?.key).toBe("value")
          expect(handle()).not.toBe(undefined)
          done()
        }
        return run + 1
      })
    })
    return done
  })

  it("should work without a context if given a repo in options", async () => {
    const { create, repo } = setup()

    await testEffect(done => {
      const [doc] = useDocSignal<ExampleDoc>(create().url, { repo })
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          done()
        }
        return run + 1
      })
    })
  })

  it("should be coarse-grained: any change triggers re-read of the whole doc", async () => {
    const { create, options } = setup()

    const signalFn = vi.fn()

    await testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(create().url, options)
      createEffect((run: number = 0) => {
        signalFn(doc()?.key, doc()?.array)
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          expect(doc()?.array).toEqual([1, 2, 3])
          // Change only the array — should still trigger the signal
          handle()?.change(doc => doc.array.push(4))
        } else if (run == 1) {
          // The whole doc is refreshed, so we see the array change
          expect(doc()?.array).toEqual([1, 2, 3, 4])
          // key remains unchanged
          expect(doc()?.key).toBe("value")
          // Now change only the key
          handle()?.change(doc => (doc.key = "updated"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("updated")
          expect(doc()?.array).toEqual([1, 2, 3, 4])
          done()
        }
        return run + 1
      })
    })

    // The signal callback should have been called 3 times (once per run)
    expect(signalFn).toHaveBeenCalledTimes(3)
  })

  it("should work with a slow handle", async () => {
    const { repo } = setup()

    const slowHandle = repo.create({
      key: "slow",
      array: [],
      nested: { title: "slow" },
    })
    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      // @ts-expect-error i'm ok i promise
      return await originalFind(...args)
    })

    const done = testEffect(done => {
      const [doc] = useDocSignal<ExampleDoc>(() => slowHandle.url, {
        repo,
        "~skipInitialValue": true,
      })
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBeUndefined()
        } else if (run == 1) {
          expect(doc()?.key).toBe("slow")
          done()
        }
        return run + 1
      })
    })
    repo.find = originalFind
    return done
  })

  it("should not apply updates from a previous handle after url changes", async () => {
    const { create, options } = setup()
    const h1 = create()
    const h2 = create()

    const [url, setURL] = createSignal<AutomergeUrl>(h1.url)

    const done = testEffect(done => {
      const [doc, handle] = useDocSignal<ExampleDoc>(url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          // Switch to h2
          setURL(h2.url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          // Change h2
          handle()?.change(doc => (doc.key = "from h2"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("from h2")
          done()
        }
        return run + 1
      })
    })
    return done
  })
})
