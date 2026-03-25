import {
  type PeerId,
  Repo,
  type AutomergeUrl,
} from "@automerge/automerge-repo"
import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { RepoContext } from "../src/context.js"
import { createEffect, createSignal, Loading } from "solid-js"
import useDocSignal from "../src/useDocSignal.js"

interface ExampleDoc {
  key: string
  array: number[]
  nested: { title: string }
}

describe("useDocSignal", () => {
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
        nested: { title: "hello" },
      })

    const handle = create()

    return {
      repo,
      handle,
      create,
      options: { repo },
    }
  }

  it("should return the initial document value", async () => {
    const { create, options } = setup()
    const createdHandle = create()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, options)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )
  })

  it("should notify on a property change", async () => {
    const { create, options } = setup()
    const createdHandle = create()
    const onKey = vi.fn()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, options)
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

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )

    createdHandle.change(doc => (doc.key = "hello world!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("hello world!")
    )
    expect(onKey).toHaveBeenLastCalledWith("hello world!")

    createdHandle.change(doc => (doc.key = "friday night!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("friday night!")
    )
    expect(onKey).toHaveBeenLastCalledWith("friday night!")
  })

  it("should return the handle as the second element", async () => {
    const { create, options } = setup()
    const createdHandle = create()
    const onHandle = vi.fn()

    const Component = () => {
      const [, handle] = useDocSignal<ExampleDoc>(createdHandle.url, options)
      createEffect(
        () => handle(),
        handle => onHandle(handle)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{handle()?.url ?? "no-handle"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent(createdHandle.url)
    )
    expect(onHandle).toHaveBeenCalledWith(
      expect.objectContaining({ url: createdHandle.url })
    )
  })

  it("should update when an array element changes", async () => {
    const { create, options } = setup()
    const createdHandle = create()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, options)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{JSON.stringify(doc()?.array)}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("[1,2,3]")
    )

    createdHandle.change(doc => doc.array.push(4))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("[1,2,3,4]")
    )
  })

  it("should update when a nested property changes", async () => {
    const { create, options } = setup()
    const createdHandle = create()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, options)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.nested.title}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("hello")
    )

    createdHandle.change(doc => (doc.nested.title = "world"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("world")
    )
  })

  it("should work with a signal url", async () => {
    const { create, repo } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(url, { repo })
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key ?? "empty"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => (
      <RepoContext value={repo}>
        <Component />
      </RepoContext>
    ))

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

  it("should clear the signal when the url returns to nothing", async () => {
    const { create, options } = setup()
    const [url, setURL] = createSignal<AutomergeUrl>()

    const Component = () => {
      const [doc, handle] = useDocSignal<ExampleDoc>(url, options)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>
            {doc()?.key ?? "empty"}|{handle() ? "has-handle" : "no-handle"}
          </button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    // no url
    await waitFor(() => {
      expect(getByRole("button")).toHaveTextContent("empty")
      expect(getByRole("button")).toHaveTextContent("no-handle")
    })

    // set url
    setURL(create().url)
    await waitFor(() => {
      expect(getByRole("button")).toHaveTextContent("value")
      expect(getByRole("button")).toHaveTextContent("has-handle")
    })

    // clear url
    setURL(undefined)
    await waitFor(() => {
      expect(getByRole("button")).toHaveTextContent("empty")
      expect(getByRole("button")).toHaveTextContent("no-handle")
    })

    // set url again
    setURL(create().url)
    await waitFor(() => {
      expect(getByRole("button")).toHaveTextContent("value")
      expect(getByRole("button")).toHaveTextContent("has-handle")
    })
  })

  it("should work without a context if given a repo in options", async () => {
    const { create, repo } = setup()
    const createdHandle = create()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, { repo })
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )
  })

  it("should be coarse-grained: any change triggers re-read of the whole doc", async () => {
    const { create, options } = setup()
    const createdHandle = create()
    const signalFn = vi.fn()

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(createdHandle.url, options)
      createEffect(
        () => [doc()?.key, doc()?.array] as const,
        ([key, array]) => signalFn(key, array)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>
            {doc()?.key}|{JSON.stringify(doc()?.array)}
          </button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value|[1,2,3]")
    )

    // Change only the array — should still trigger the signal
    createdHandle.change(doc => doc.array.push(4))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value|[1,2,3,4]")
    )

    // Now change only the key
    createdHandle.change(doc => (doc.key = "updated"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("updated|[1,2,3,4]")
    )

    // The signal callback should have been called 3 times (initial + 2 changes)
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

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(() => slowHandle.url, {
        repo,
        "~skipInitialValue": true,
      })
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key ?? "waiting"}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    // initially loading
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("loading")
    )

    // eventually resolves
    await waitFor(
      () => expect(getByRole("button")).toHaveTextContent("slow"),
      { timeout: 3000 }
    )

    repo.find = originalFind
  })

  it("should not apply updates from a previous handle after url changes", async () => {
    const { create, options } = setup()
    const h1 = create()
    const h2 = create()

    const [url, setURL] = createSignal<AutomergeUrl>(h1.url)

    const Component = () => {
      const [doc] = useDocSignal<ExampleDoc>(url, options)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc()?.key}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    // starts with h1
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )

    // switch to h2
    setURL(h2.url)
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("value")
    )

    // change h2
    h2.change(doc => (doc.key = "from h2"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("from h2")
    )
  })
})
