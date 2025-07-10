import {
  type AutomergeUrl,
  type DocHandle,
  type PeerId,
  Repo,
} from "@automerge/automerge-repo"
import { render, renderHook, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import useDocHandle from "../src/useDocHandle.js"
import { RepoContext } from "../src/context.js"
import {
  createEffect,
  createSignal,
  on,
  Suspense,
  untrack,
  type ParentComponent,
} from "solid-js"
import type { UseDocHandleOptions } from "../src/types.js"

interface ExampleDoc {
  foo: string
}

function getRepoWrapper(repo: Repo): ParentComponent {
  return props => (
    <RepoContext.Provider value={repo}>{props.children}</RepoContext.Provider>
  )
}

describe("useDocHandle", () => {
  afterEach(() => {
    document.body.innerHTML = ""
  })
  const repo = new Repo({
    peerId: "bob" as PeerId,
  })

  function setup() {
    const handleA = repo.create<ExampleDoc>()
    handleA.change(doc => (doc.foo = "A"))

    const handleB = repo.create<ExampleDoc>()
    handleB.change(doc => (doc.foo = "B"))

    return {
      repo,
      handleA,
      handleB,
      wrapper: getRepoWrapper(repo),
    }
  }

  const Component = (props: {
    url: AutomergeUrl | undefined
    onHandle: (handle: DocHandle<unknown> | undefined) => void
    options?: UseDocHandleOptions
  }) => {
    const handle = useDocHandle(
      () => props.url,
      untrack(() => props.options)
    )
    createEffect(
      on([handle], () => {
        props.onHandle(handle())
      })
    )

    return (
      <Suspense fallback={<div>fallback</div>}>
        <button>{handle.latest?.url ?? "🕯️🕯️🕯️🕯️"}</button>
      </Suspense>
    )
  }

  it("loads a handle", async () => {
    const { handleA, wrapper } = setup()
    const onHandle = vi.fn()

    render(() => <Component url={handleA.url} onHandle={onHandle} />, {
      wrapper,
    })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))
  })

  it("throws if called without any kinda repo", async () => {
    const { handleA } = setup()
    const onHandle = vi.fn()

    expect(() =>
      render(() => <Component url={handleA.url} onHandle={onHandle} />, {})
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: use outside <RepoContext> requires options.repo]`
    )
  })

  it("works without a context if given a repo in options", async () => {
    const { handleA } = setup()
    const onHandle = vi.fn()

    render(
      () => (
        <Component url={handleA.url} onHandle={onHandle} options={{ repo }} />
      ),
      {}
    )
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))
  })

  it("returns undefined when no url given", async () => {
    const { wrapper } = setup()
    const onHandle = vi.fn()

    render(() => <Component url={undefined} onHandle={onHandle} />, { wrapper })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(undefined))
  })

  it("updates the handle when the url changes", async () => {
    const { handleA, handleB, wrapper } = setup()
    const onHandle = vi.fn()
    const [url, updateURL] = createSignal<AutomergeUrl | undefined>(undefined)

    let hookResult = renderHook(useDocHandle, {
      initialProps: [url],
      wrapper,
    })

    let componentResult = render(
      () => <Component url={url()} onHandle={onHandle} />,
      { wrapper }
    )
    let button = componentResult.getByRole("button")

    // set url to doc A
    updateURL(handleA.url)
    await waitFor(() => expect(hookResult.result.latest).toBe(handleA))
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    await waitFor(() => expect(button).toHaveTextContent(handleA.url))

    // set url to doc B
    updateURL(handleB.url)
    await waitFor(() => expect(hookResult.result.latest?.url).toBe(handleB.url))

    await waitFor(() => expect(button).toHaveTextContent(handleB.url))

    // set url to undefined
    updateURL(undefined)
    await waitFor(() => expect(hookResult.result.latest?.url).toBe(undefined))

    await waitFor(() => expect(button).toHaveTextContent("🕯️🕯️🕯️🕯️"))
  })

  it("does not return undefined after the url is updated", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()
    const [url, updateURL] = createSignal<AutomergeUrl | undefined>(handleA.url)

    render(() => <Component url={url()} onHandle={onHandle} />, { wrapper })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    const onHandle2 = vi.fn()

    // set url to doc B
    updateURL(handleB.url)
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(undefined))
  })

  it("does not return a handle for a different url after the url is updated", async () => {
    const { wrapper, handleA, handleB } = setup()
    const onHandle = vi.fn()
    const [url, updateURL] = createSignal<AutomergeUrl | undefined>(handleA.url)

    render(() => <Component url={url()} onHandle={onHandle} />, { wrapper })
    await waitFor(() => expect(onHandle).toHaveBeenLastCalledWith(handleA))

    const onHandle2 = vi.fn()

    // set url to doc B
    updateURL(handleB.url)
    await waitFor(() => expect(onHandle2).not.toHaveBeenCalledWith(handleA))
  })
})
