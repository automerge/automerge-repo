import { type PeerId, Repo } from "@automerge/automerge-repo"

import { render, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createEffect, Loading } from "solid-js"
import makeDocumentProjection from "../src/makeDocumentProjection.js"

interface ExampleDoc {
  key: string
  array: number[]
  hellos: { hello: string }[]
  projects: {
    title: string
    items: { title: string; complete?: number }[]
  }[]
}

describe("makeDocumentProjection", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })

  function setup() {
    const repo = new Repo({
      peerId: "bob" as PeerId,
    })

    const handle = repo.create<ExampleDoc>({
      key: "value",
      array: [1, 2, 3],
      hellos: [{ hello: "world" }, { hello: "hedgehog" }],
      projects: [
        { title: "one", items: [{ title: "go shopping" }] },
        { title: "two", items: [] },
      ],
    })

    return { repo, handle }
  }

  it("should notify on a property change", async () => {
    const { handle } = setup()
    const onKey = vi.fn()

    const Component = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => doc.key,
        key => onKey(key)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc.key}</button>
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

  it("should not apply patches multiple times just because there are multiple projections of the same handle", async () => {
    const { handle } = setup()
    const onArray1 = vi.fn()
    const onArray2 = vi.fn()

    const Component1 = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => [...doc.array],
        arr => onArray1(arr)
      )
      return (
        <Loading fallback={<span data-testid="one">loading</span>}>
          <span data-testid="one">{JSON.stringify(doc.array)}</span>
        </Loading>
      )
    }

    const Component2 = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => [...doc.array],
        arr => onArray2(arr)
      )
      return (
        <Loading fallback={<span data-testid="two">loading</span>}>
          <span data-testid="two">{JSON.stringify(doc.array)}</span>
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

  it("should notify on a deep property change", async () => {
    const { handle } = setup()
    const onTitle = vi.fn()

    const Component = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => doc.projects[0].title,
        title => onTitle(title)
      )
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc.projects[0].title}</button>
        </Loading>
      )
    }

    const { getByRole } = render(() => <Component />)

    handle.change(doc => (doc.projects[0].title = "hello world!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("hello world!")
    )
    expect(onTitle).toHaveBeenLastCalledWith("hello world!")

    handle.change(doc => (doc.projects[0].title = "friday night!"))
    await waitFor(() =>
      expect(getByRole("button")).toHaveTextContent("friday night!")
    )
    expect(onTitle).toHaveBeenLastCalledWith("friday night!")
  })

  it("should not clean up when it should not clean up", async () => {
    const { handle } = setup()

    const ProjectionComponent = (props: { testid: string }) => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      return (
        <Loading
          fallback={<span data-testid={props.testid}>loading</span>}
        >
          <span data-testid={props.testid}>{doc.projects[0].title}</span>
        </Loading>
      )
    }

    const r1 = render(() => <ProjectionComponent testid="one" />)
    const r2 = render(() => <ProjectionComponent testid="two" />)
    const r3 = render(() => <ProjectionComponent testid="three" />)

    // resolve the projections with a change
    handle.change(doc => (doc.projects[0].title = "hello world!"))
    await waitFor(() => {
      expect(r1.getByTestId("one")).toHaveTextContent("hello world!")
      expect(r2.getByTestId("two")).toHaveTextContent("hello world!")
      expect(r3.getByTestId("three")).toHaveTextContent("hello world!")
    })

    // remove second projection — updates should carry on because there are still references
    r2.unmount()

    handle.change(doc => (doc.projects[0].title = "friday night!"))
    await waitFor(() => {
      expect(r1.getByTestId("one")).toHaveTextContent("friday night!")
      expect(r3.getByTestId("three")).toHaveTextContent("friday night!")
    })

    // remove third projection — updates should carry on because there is still one left
    r3.unmount()

    handle.change(doc => (doc.projects[0].title = "saturday morning!"))
    await waitFor(() => {
      expect(r1.getByTestId("one")).toHaveTextContent("saturday morning!")
    })

    // remove last projection — no more references, listener should be cleaned up
    r1.unmount()

    // changes after all projections removed should not cause errors
    handle.change(doc => (doc.projects[0].title = "nobody listening"))
  })

  it("should not notify on properties nobody cares about", async () => {
    const { handle } = setup()
    const onProjectOneTitle = vi.fn()
    const onArrayThree = vi.fn()
    const onProjectZeroItemZeroTitle = vi.fn()

    const Component = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      createEffect(
        () => doc.projects[1].title,
        t => onProjectOneTitle(t)
      )
      createEffect(
        () => doc.array[3],
        v => onArrayThree(v)
      )
      createEffect(
        () => doc.projects[0].items[0].title,
        t => onProjectZeroItemZeroTitle(t)
      )
      return (
        <Loading fallback={<div>loading</div>}>
          <div>{doc.key}</div>
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

  it("should remain reactive on mount, unmount, and then remount of the same doc handle", async () => {
    const { handle } = setup()

    const Component = () => {
      const doc = makeDocumentProjection<ExampleDoc>(handle)
      return (
        <Loading fallback={<button>loading</button>}>
          <button>{doc.key}</button>
        </Loading>
      )
    }

    // first mount
    const r1 = render(() => <Component />)

    handle.change(doc => (doc.key = "hello world!"))
    await waitFor(() =>
      expect(r1.getByRole("button")).toHaveTextContent("hello world!")
    )

    handle.change(doc => (doc.key = "friday night!"))
    await waitFor(() =>
      expect(r1.getByRole("button")).toHaveTextContent("friday night!")
    )

    // unmount
    r1.unmount()

    // reset value
    handle.change(doc => (doc.key = "value"))

    // remount
    const r2 = render(() => <Component />)

    handle.change(doc => (doc.key = "hello world!"))
    await waitFor(() =>
      expect(r2.getByRole("button")).toHaveTextContent("hello world!")
    )

    handle.change(doc => (doc.key = "friday night!"))
    await waitFor(() =>
      expect(r2.getByRole("button")).toHaveTextContent("friday night!")
    )

    r2.unmount()
  })
})
