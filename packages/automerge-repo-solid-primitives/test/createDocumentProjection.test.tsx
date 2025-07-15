import {
  Repo,
  type PeerId,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo"
import { render, renderHook, testEffect } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import {
  createEffect,
  createSignal,
  type Accessor,
  type ParentComponent,
} from "solid-js"
import useDocHandle from "../src/useDocHandle.js"
import createDocumentProjection from "../src/createDocumentProjection.js"

describe("createDocumentProjection", () => {
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
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [() => handle],
      }
    )

    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe("value")
          handle.change(doc => (doc.key = "hello world!"))
        } else if (run == 1) {
          expect(doc()?.key).toBe("hello world!")
          handle.change(doc => (doc.key = "friday night!"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("friday night!")
          done()
        }
        return run + 1
      })
    }, owner!)
    return done
  })

  it("should not apply patches multiple times just because there are multiple projections", async () => {
    const { handle } = setup()
    const { result: one, owner: owner1 } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [() => handle],
      }
    )
    const { result: two, owner: owner2 } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [() => handle],
      }
    )

    const done2 = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(two()?.array).toEqual([1, 2, 3])
        } else if (run == 1) {
          expect(two()?.array).toEqual([1, 2, 3, 4])
        } else if (run == 2) {
          expect(two()?.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    }, owner2!)

    const done1 = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(one()?.array).toEqual([1, 2, 3])
          handle.change(doc => doc.array.push(4))
        } else if (run == 1) {
          expect(one()?.array).toEqual([1, 2, 3, 4])
          handle.change(doc => doc.array.push(5))
        } else if (run == 2) {
          expect(one()?.array).toEqual([1, 2, 3, 4, 5])
          done()
        }
        return run + 1
      })
    }, owner1!)

    return Promise.allSettled([done1, done2])
  })

  it("should work with useDocHandle", async () => {
    const {
      handle: { url: startingUrl },
      wrapper,
    } = setup()

    const [url, setURL] = createSignal<AutomergeUrl>()

    const { result: handle } = renderHook(useDocHandle<ExampleDoc>, {
      initialProps: [url],
      wrapper,
    })

    const { result: doc, owner } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [handle],
      }
    )

    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe(undefined)
          setURL(startingUrl)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          handle()?.change(doc => (doc.key = "hello world!"))
        } else if (run == 2) {
          expect(doc()?.key).toBe("hello world!")
          handle()?.change(doc => (doc.key = "friday night!"))
        } else if (run == 3) {
          expect(doc()?.key).toBe("friday night!")
          done()
        }

        return run + 1
      })
    }, owner!)

    return done
  })

  it("should work with a signal url", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()
    const { result: handle } = renderHook(useDocHandle<ExampleDoc>, {
      initialProps: [url],
      wrapper,
    })
    const { result: doc, owner } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [handle],
        wrapper,
      }
    )
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

  it("should clear the store when the signal returns to nothing", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()
    const { result: handle } = renderHook(useDocHandle<ExampleDoc>, {
      initialProps: [url],
      wrapper,
    })
    const { result: doc, owner } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [handle],
        wrapper,
      }
    )

    const done = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.key).toBe(undefined)
          setURL(create().url)
        } else if (run == 1) {
          expect(doc()?.key).toBe("value")
          setURL(undefined)
        } else if (run == 2) {
          expect(doc()?.key).toBe(undefined)
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

  it("should not return the wrong store when handle changes", async () => {
    const { create } = setup()

    const h1 = create()
    const h2 = create()

    const [stableHandle] = createSignal(h1)
    // initially handle2 is the same as handle1
    const [changingHandle, setChangingHandle] = createSignal(h1)

    const { result } = renderHook<[], () => readonly [string, string]>(() => {
      function Component(props: {
        stableHandle: Accessor<DocHandle<ExampleDoc>>
        changingHandle: Accessor<DocHandle<ExampleDoc>>
      }) {
        const stableDoc = createDocumentProjection<ExampleDoc>(
          // eslint-disable-next-line solid/reactivity
          props.stableHandle
        )

        const changingDoc = createDocumentProjection<ExampleDoc>(
          // eslint-disable-next-line solid/reactivity
          props.changingHandle
        )

        return () => [stableDoc()!.key, changingDoc()!.key] as const
      }

      return Component({
        stableHandle,
        changingHandle,
      })
    })

    return testEffect(async done => {
      h2.change(doc => (doc.key = "document-2"))
      expect(result()).toEqual(["value", "value"])

      h1.change(doc => (doc.key = "hello"))
      await new Promise<void>(setImmediate)
      expect(result()).toEqual(["hello", "hello"])

      setChangingHandle(() => h2)
      expect(result()).toEqual(["hello", "document-2"])

      setChangingHandle(() => h1)
      expect(result()).toEqual(["hello", "hello"])

      setChangingHandle(h2)
      h2.change(doc => (doc.key = "world"))
      await new Promise<void>(setImmediate)
      expect(result()).toEqual(["hello", "world"])
      done()
    })
  })

  it("should work ok with a slow handle", async () => {
    const { repo } = setup()

    const originalFind = repo.find.bind(repo)
    repo.find = vi.fn().mockImplementation(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 900))
      // @ts-expect-error this is ok
      return originalFind(...args)
    })

    await testEffect(done => {
      const handle = useDocHandle<{ im: "slow" }>(
        () => repo.create({ im: "slow" }).url,
        { repo }
      )
      const doc = createDocumentProjection(handle)

      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.im).toBe("slow")
          done()
        }
        return run + 1
      })
    })

    repo.find = originalFind
  })

  it("should not notify on properties nobody cares about", async () => {
    const { handle } = setup()
    let fn = vi.fn()

    const { result: doc, owner } = renderHook(
      createDocumentProjection<ExampleDoc>,
      {
        initialProps: [() => handle],
      }
    )
    testEffect(() => {
      createEffect(() => {
        fn(doc()?.projects[1].title)
      })
    })
    const arrayDotThree = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.array[3]).toBeUndefined()
          handle.change(doc => (doc.array[2] = 22))
          handle.change(doc => (doc.key = "hello world!"))
          handle.change(doc => (doc.array[1] = 11))
          handle.change(doc => (doc.array[3] = 145))
        } else if (run == 1) {
          expect(doc()?.array[3]).toBe(145)
          handle.change(doc => (doc.projects[0].title = "hello world!"))
          handle.change(
            doc => (doc.projects[0].items[0].title = "hello world!")
          )
          handle.change(doc => (doc.array[3] = 147))
        } else if (run == 2) {
          expect(doc()?.array[3]).toBe(147)
          done()
        }
        return run + 1
      })
    }, owner!)
    const projectZeroItemZeroTitle = testEffect(done => {
      createEffect((run: number = 0) => {
        if (run == 0) {
          expect(doc()?.projects[0].items[0].title).toBe("hello world!")
          done()
        }
        return run + 1
      })
    }, owner!)

    expect(fn).toHaveBeenCalledOnce()
    expect(fn).toHaveBeenCalledWith("two")

    return Promise.all([arrayDotThree, projectZeroItemZeroTitle])
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
