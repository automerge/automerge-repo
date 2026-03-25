import {
  Repo,
  type PeerId,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/automerge-repo"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import {
  createEffect,
  createSignal,
  Loading,
  type ParentComponent,
} from "solid-js"
import useDocHandle from "../src/useDocHandle.js"
import createDocumentProjection from "../src/createDocumentProjection.js"

describe("createDocumentProjection", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

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
      return <RepoContext value={repo}>{props.children}</RepoContext>
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
    const onKey = vi.fn()

    const Component = () => {
      const doc = createDocumentProjection<ExampleDoc>(() => handle)
      createEffect(
        () => doc()?.key,
        key => onKey(key)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    handle.change(doc => (doc.key = "hello world!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("hello world!")
    )
    expect(onKey).toHaveBeenLastCalledWith("hello world!")

    handle.change(doc => (doc.key = "friday night!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("friday night!")
    )
    expect(onKey).toHaveBeenLastCalledWith("friday night!")
  })

  it("should not apply patches multiple times just because there are multiple projections", async () => {
    const { handle } = setup()
    const onArray1 = vi.fn()
    const onArray2 = vi.fn()

    const Component1 = () => {
      const doc = createDocumentProjection<ExampleDoc>(() => handle)
      createEffect(
        () => doc()?.array && [...doc()!.array],
        arr => onArray1(arr)
      )
      return (
        <Loading fallback={<span data-testid="one">loading</span>}>
          <span data-testid="one">{JSON.stringify(doc()?.array)}</span>
        </Loading>
      )
    }

    const Component2 = () => {
      const doc = createDocumentProjection<ExampleDoc>(() => handle)
      createEffect(
        () => doc()?.array && [...doc()!.array],
        arr => onArray2(arr)
      )
      return (
        <Loading fallback={<span data-testid="two">loading</span>}>
          <span data-testid="two">{JSON.stringify(doc()?.array)}</span>
        </Loading>
      )
    }

    render(() => (
      <>
        <Component1 />
        <Component2 />
      </>
    ))

    handle.change(doc => doc.array.push(4))
    await waitFor(() =>
      expect(onArray1).toHaveBeenLastCalledWith([1, 2, 3, 4])
    )
    await waitFor(() =>
      expect(onArray2).toHaveBeenLastCalledWith([1, 2, 3, 4])
    )

    handle.change(doc => doc.array.push(5))
    await waitFor(() =>
      expect(onArray1).toHaveBeenLastCalledWith([1, 2, 3, 4, 5])
    )
    await waitFor(() =>
      expect(onArray2).toHaveBeenLastCalledWith([1, 2, 3, 4, 5])
    )
  })

  it("should work with useDocHandle", async () => {
    const {
      handle: { url: startingUrl },
      wrapper,
    } = setup()

    const [url, setURL] = createSignal<AutomergeUrl>()
    const onKey = vi.fn()

    const Component = () => {
      const handle = useDocHandle<ExampleDoc>(() => url())
      const doc = createDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => doc()?.key,
        key => onKey(key)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key ?? "empty"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />, { wrapper })

    // initially no url, doc should be undefined
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("empty")
    )

    // set the url — doc should load
    setURL(startingUrl)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )
    expect(onKey).toHaveBeenLastCalledWith("value")
  })

  it("should work with a signal url", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()
    const onKey = vi.fn()

    const Component = () => {
      const handle = useDocHandle<ExampleDoc>(() => url())
      const doc = createDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => doc()?.key,
        key => onKey(key)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key ?? "empty"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />, { wrapper })

    // no url yet
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("empty")
    )

    // set url to first doc
    const handle1 = create()
    setURL(handle1.url)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )

    // change the doc
    handle1.change(doc => (doc.key = "hello world!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("hello world!")
    )

    // switch to a new doc
    setURL(create().url)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )
  })

  it("should clear the store when the signal returns to nothing", async () => {
    const { create, wrapper } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()

    const Component = () => {
      const handle = useDocHandle<ExampleDoc>(() => url())
      const doc = createDocumentProjection<ExampleDoc>(handle)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key ?? "empty"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />, { wrapper })

    // no url
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("empty")
    )

    // set url
    setURL(create().url)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )

    // clear url
    setURL(undefined)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("empty")
    )

    // set url again
    setURL(create().url)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )
  })

  it("should not return the wrong store when handle changes", async () => {
    const { create } = setup()

    const h1 = create()
    const h2 = create()
    h2.change(doc => (doc.key = "document-2"))

    const [changingHandle, setChangingHandle] = createSignal<
      DocHandle<ExampleDoc>
    >(h1)

    const Component = () => {
      const stableDoc = createDocumentProjection<ExampleDoc>(() => h1)
      const changingDoc = createDocumentProjection<ExampleDoc>(changingHandle)
      return (
        <Loading fallback={<div>loading</div>}>
          <span data-testid="stable">{stableDoc()?.key}</span>
          <span data-testid="changing">{changingDoc()?.key}</span>
        </Loading>
      )
    }

    const { getByTestId } = render(() => <Component />)

    // both should start with h1's value
    await waitFor(() => {
      expect(getByTestId("stable")).toHaveTextContent("value")
      expect(getByTestId("changing")).toHaveTextContent("value")
    })

    // change h1
    h1.change(doc => (doc.key = "hello"))
    await waitFor(() => {
      expect(getByTestId("stable")).toHaveTextContent("hello")
      expect(getByTestId("changing")).toHaveTextContent("hello")
    })

    // switch changing to h2
    setChangingHandle(() => h2)
    await waitFor(() => {
      expect(getByTestId("stable")).toHaveTextContent("hello")
      expect(getByTestId("changing")).toHaveTextContent("document-2")
    })

    // switch back to h1
    setChangingHandle(() => h1)
    await waitFor(() => {
      expect(getByTestId("stable")).toHaveTextContent("hello")
      expect(getByTestId("changing")).toHaveTextContent("hello")
    })

    // switch to h2 and mutate it
    setChangingHandle(h2)
    h2.change(doc => (doc.key = "world"))
    await waitFor(() => {
      expect(getByTestId("stable")).toHaveTextContent("hello")
      expect(getByTestId("changing")).toHaveTextContent("world")
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

    const Component = () => {
      const handle = useDocHandle<{ im: "slow" }>(
        () => repo.create({ im: "slow" }).url,
        { repo }
      )
      const doc = createDocumentProjection(handle)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.im}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() => expect(getByRole("button")).toHaveTextContent("slow"), {
      timeout: 3000,
    })

    repo.find = originalFind
  })

  it("should not notify on properties nobody cares about", async () => {
    const { handle } = setup()
    const onProjectOneTitle = vi.fn()
    const onArrayThree = vi.fn()
    const onProjectZeroItemZeroTitle = vi.fn()

    const Component = () => {
      const doc = createDocumentProjection<ExampleDoc>(() => handle)
      createEffect(
        () => doc()?.projects[1].title,
        t => onProjectOneTitle(t)
      )
      createEffect(
        () => doc()?.array[3],
        v => onArrayThree(v)
      )
      createEffect(
        () => doc()?.projects[0].items[0].title,
        t => onProjectZeroItemZeroTitle(t)
      )
      return (
        <Loading fallback={<div>loading</div>}>
          <div>{doc()?.key}</div>
        </Loading>
      )
    }

    render(() => <Component />)

    // resolve the projection with a batch of changes including array[3]
    handle.change(doc => {
      doc.array[2] = 22
      doc.key = "hello world!"
      doc.array[1] = 11
      doc.array[3] = 145
    })

    await waitFor(() => expect(onArrayThree).toHaveBeenLastCalledWith(145))

    // projects[1].title should have been called once (initial resolve) with "two"
    expect(onProjectOneTitle).toHaveBeenCalledTimes(1)
    expect(onProjectOneTitle).toHaveBeenCalledWith("two")

    // more changes in a single batch
    handle.change(doc => {
      doc.projects[0].title = "hello world!"
      doc.projects[0].items[0].title = "hello world!"
      doc.array[3] = 147
    })

    await waitFor(() => expect(onArrayThree).toHaveBeenLastCalledWith(147))
    await waitFor(() =>
      expect(onProjectZeroItemZeroTitle).toHaveBeenLastCalledWith(
        "hello world!"
      )
    )

    // projects[1].title should STILL not have been called again
    expect(onProjectOneTitle).toHaveBeenCalledTimes(1)
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
