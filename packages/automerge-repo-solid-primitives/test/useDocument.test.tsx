import { type PeerId, Repo, type AutomergeUrl } from "@automerge/automerge-repo"
import { render, renderHook, testEffect } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import {
  createEffect,
  createSignal,
  type Accessor,
  type ParentComponent,
} from "solid-js"
import useDocument from "../src/useDocument.js"

describe("useDocument", () => {
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
      options: { repo },
    }
  }

  it("should notify on a property change", async () => {
    const { create, options } = setup()

    await testEffect(done => {
      const [doc, handle] = useDocument<ExampleDoc>(create().url, options)
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

  it("should not apply patches multiple times just because there are multiple projections", async () => {
    const {
      handle: { url },
      options,
    } = setup()

    const done2 = testEffect(done => {
      const [two, handle] = useDocument<ExampleDoc>(url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(two()?.array).toEqual([1, 2, 3])
        } else if (run == 1) {
          expect(two()?.array).toEqual([1, 2, 3, 4])
          handle()?.change(doc => doc.array.push(5))
        } else if (run == 2) {
          expect(two()?.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    })

    const done1 = testEffect(done => {
      const [one, handle] = useDocument<ExampleDoc>(url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(one()?.array).toEqual([1, 2, 3])
          handle()?.change(doc => doc.array.push(4))
        } else if (run == 1) {
          expect(one()?.array).toEqual([1, 2, 3, 4])
        } else if (run == 2) {
          expect(one()?.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    })

    return Promise.allSettled([done1, done2])
  })

  it("should work with a signal url", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()
    const {
      result: [doc, handle],
      owner,
    } = renderHook(useDocument<ExampleDoc>, {
      initialProps: [url],
      wrapper,
    })
    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe(undefined)
          setURL(create().url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          handle()?.change(doc => (doc.key = "hello world!"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("hello world!")
          setURL(create().url)
        } else if (run == 3) {
          expect(doc()?.key).toBe("value")
          handle()?.change(doc => (doc.key = "friday night!"))
        } else if (run == 4) {
          expect(doc()?.key).toBe("friday night!")
          done()
        }

        return run + 1
      })
    }, owner!)
    return done
  })

  it("should clear the store when the url signal returns to nothing", async () => {
    const { create, options } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()

    const done = testEffect(done => {
      const [doc, handle] = useDocument<ExampleDoc>(url, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe(undefined)
          expect(handle()).toBe(undefined)
          setURL(create().url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          expect(handle()).not.toBe(undefined)
          setURL(undefined)
        } else if (run == 2) {
          expect(doc()?.key).toBe(undefined)
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

  it("should not return the wrong store when url changes", async () => {
    const { create, repo } = setup()
    const h1 = create()
    const h2 = create()
    const u1 = h1.url
    const u2 = h2.url

    const [stableURL] = createSignal(u1)
    const [changingURL, setChangingURL] = createSignal(u1)

    await testEffect(async done => {
      const result = render(() => {
        function Component(props: {
          stableURL: Accessor<AutomergeUrl>
          changingURL: Accessor<AutomergeUrl>
        }) {
          const [stableDoc] = useDocument<ExampleDoc>(() => props.stableURL())

          const [changingDoc] = useDocument<ExampleDoc>(() =>
            props.changingURL()
          )

          return (
            <>
              <div data-testid="key-stable">{stableDoc()?.key}</div>
              <div data-testid="key-changing">{changingDoc()?.key}</div>
            </>
          )
        }

        return (
          <RepoContext.Provider value={repo}>
            <Component stableURL={stableURL} changingURL={changingURL} />
          </RepoContext.Provider>
        )
      })

      h2.change(doc => (doc.key = "document-2"))
      expect(result.getByTestId("key-stable").textContent).toBe("value")
      expect(result.getByTestId("key-changing").textContent).toBe("value")

      h1.change(doc => (doc.key = "hello"))
      await new Promise(yay => setImmediate(yay))

      expect(result.getByTestId("key-stable").textContent).toBe("hello")
      expect(result.getByTestId("key-changing").textContent).toBe("hello")

      setChangingURL(u2)
      await new Promise(yay => setImmediate(yay))
      expect(result.getByTestId("key-stable").textContent).toBe("hello")
      expect(result.getByTestId("key-changing").textContent).toBe("document-2")
      h2.change(doc => (doc.key = "world"))

      setChangingURL(u1)
      await new Promise(yay => setImmediate(yay))
      expect(result.getByTestId("key-stable").textContent).toBe("hello")
      expect(result.getByTestId("key-changing").textContent).toBe("hello")

      setChangingURL(u2)
      await new Promise(yay => setImmediate(yay))

      expect(result.getByTestId("key-stable").textContent).toBe("hello")
      expect(result.getByTestId("key-changing").textContent).toBe("world")

      done()
    })
  })

  it("should work with a slow handle", async () => {
    const { repo } = setup()

    const slowHandle = repo.create({ im: "slow" })
    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 100))
      // @ts-expect-error i'm ok i promise
      return await originalFind(...args)
    })

    const done = testEffect(done => {
      const [doc] = useDocument<{ im: "slow" }>(() => slowHandle.url, {
        repo,
        "~skipInitialValue": true,
      })
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.im).toBe(undefined)
        } else if (run == 1) {
          expect(doc()?.im).toBe("slow")
          done()
        }
        return run + 1
      })
    })
    repo.find = originalFind
    return done
  })

  it("should not notify on properties nobody cares about", async () => {
    const {
      handle: { url },
      options,
    } = setup()

    let fn = vi.fn()

    const [doc, handle] = useDocument<ExampleDoc>(url, options)

    testEffect(() => {
      createEffect(() => {
        fn(doc()?.projects[1].title)
      })
    })
    const arrayDotThree = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.array[3]).toBeUndefined()
          handle()?.change(doc => (doc.array[2] = 22))
          handle()?.change(doc => (doc.key = "hello world!"))
          handle()?.change(doc => (doc.array[1] = 11))
          handle()?.change(doc => (doc.array[3] = 145))
        } else if (run == 1) {
          expect(doc()?.array[3]).toBe(145)
          handle()?.change(doc => (doc.projects[0].title = "hello world!"))
          handle()?.change(
            doc => (doc.projects[0].items[0].title = "hello world!")
          )
          handle()?.change(doc => (doc.array[3] = 147))
        } else if (run == 2) {
          expect(doc()?.array[3]).toBe(147)
          done()
        }
        return run + 1
      })
    })

    const projectZeroItemZeroTitle = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.projects[0].items[0].title).toBe("hello world!")
          done()
        }
        return run + 1
      })
    })

    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith("two")

    return Promise.all([arrayDotThree, projectZeroItemZeroTitle])
  })

  it("should resolve a ref (sub-document) url to a scoped handle", async () => {
    const { handle, options } = setup()
    const subUrl = handle.sub("projects", 0).url
    // index segments serialize as `@0`
    expect(subUrl).toBe(`${handle.url}/projects/@0`)

    await testEffect(done => {
      const [doc, subHandle] = useDocument<{
        title: string
        items: { title: string }[]
      }>(subUrl, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          // the projection is the scoped value, not the whole document
          expect(doc()?.title).toBe("one")
          expect(subHandle()?.url).toBe(subUrl)
          // NB: block body - returning a value from a scoped object change
          // would *replace* the whole sub-tree instead of mutating it.
          subHandle()?.change(d => {
            d.title = "uno"
          })
        } else if (run == 1) {
          expect(doc()?.title).toBe("uno")
          done()
        }
        return run + 1
      })
    })
  })

  it("should update a ref-url projection when an ancestor mutates the sub-tree", async () => {
    const { handle, options } = setup()
    const subUrl = handle.sub("projects", 0, "items", 0).url

    await testEffect(done => {
      const [doc] = useDocument<{ title: string }>(subUrl, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.title).toBe("go shopping")
          // mutate through the root handle; the scoped projection updates
          handle.change(d => (d.projects[0].items[0].title = "buy milk"))
        } else if (run == 1) {
          expect(doc()?.title).toBe("buy milk")
          done()
        }
        return run + 1
      })
    })
  })

  it("clears a pattern-ref projection when its matched element is deleted", async () => {
    const { handle, options } = setup()
    // Pattern sub-URL: the element of `hellos` matching `{ hello: "hedgehog" }`.
    const subUrl = handle.sub("hellos", { hello: "hedgehog" }).url

    await testEffect(done => {
      const [doc] = useDocument<{ hello: string }>(subUrl, options)
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.hello).toBe("hedgehog")
          // Delete the matched element through the root handle.
          handle.change(d => d.hellos.deleteAt(1))
        } else if (run == 1) {
          // The scoped projection must react to the disappearance.
          expect(doc()?.hello).toBeUndefined()
          done()
        }
        return run + 1
      })
    })
  })

  it("should resolve a ref url pinned at heads (heads + path)", async () => {
    const { handle, options } = setup()
    // heads at the initial value, then mutate the scoped sub-tree
    const headsAtOne = handle.heads()
    handle.change(d => (d.projects[0].title = "two"))

    // URL carries both a path suffix and fixed heads
    const pinnedSubUrl = handle.sub("projects", 0).view(headsAtOne).url
    expect(pinnedSubUrl).toContain("/projects/@0")
    expect(pinnedSubUrl).toContain("#")

    await testEffect(done => {
      const [doc] = useDocument<{ title: string }>(pinnedSubUrl, options)
      createEffect(() => {
        // the projection reflects the value at the pinned heads, scoped to
        // the path - so the initial materialization must be heads-aware
        expect(doc()?.title).toBe("one")
        done()
      })
    })
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
