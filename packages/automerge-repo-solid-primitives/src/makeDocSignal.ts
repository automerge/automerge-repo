import { onCleanup, type Accessor } from "solid-js"
import { createSignal } from "solid-js"
import type { Doc, DocHandle, Handle } from "@automerge/automerge-repo/slim"
import type { ValueOf } from "./types.js"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_. works with handles of any doc type.
 * @param handle an Automerge
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function makeDocSignal<H extends Handle<any, any, any>>(
  handle: H
): Accessor<ValueOf<H> | undefined>
export default function makeDocSignal<T extends object>(
  handle: DocHandle<T>
): Accessor<Doc<T> | undefined>
export default function makeDocSignal(
  handle: Handle<any, any, any>
): Accessor<unknown> {
  const [signal, setSignal] = createSignal<unknown>(handle.doc())

  function update() {
    setSignal(() => handle.doc())
  }

  handle.on("change", update)
  onCleanup(() => handle.off("change", update))

  return signal
}
