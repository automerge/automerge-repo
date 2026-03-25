import { createMemo, onCleanup, type Accessor } from "solid-js"
import type { Doc, DocHandle } from "@automerge/automerge-repo/slim"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_. works with {@link useDocHandle}.
 * @param handle an accessor (signal/resource) of a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function createDocSignal<T extends object>(
  handle: Accessor<DocHandle<T> | undefined>
): Accessor<Doc<T> | undefined> {
  return createMemo(async function* () {
    let p = Promise.withResolvers<Doc<T>>()
    function onchange() {
      p.resolve(handle()?.doc() as Doc<T>)
    }
    let currentHandle = handle()
    while (!currentHandle) {
      yield undefined
      currentHandle = handle()
    }
    currentHandle.on("change", onchange)
    onCleanup(() => currentHandle?.off("change", onchange))
    yield currentHandle.doc() as Doc<T>
    while (true) {
      yield await p.promise
      p = Promise.withResolvers<Doc<T>>()
    }
  })
}
