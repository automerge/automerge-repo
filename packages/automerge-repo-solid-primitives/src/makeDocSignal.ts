import { onCleanup, type Accessor } from "solid-js"
import { createSignal } from "solid-js"
import type { Doc, DocHandle } from "@automerge/automerge-repo/slim"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_.
 * @param handle an Automerge
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function makeDocSignal<T extends object>(
  handle: DocHandle<T>
): Accessor<Doc<T> | undefined> {
  const [signal, setSignal] = createSignal<Doc<T> | undefined>(() =>
    handle.doc()
  )

  function update() {
    setSignal(() => handle.doc() as Doc<T> | undefined)
  }

  handle.on("change", update)
  onCleanup(() => handle.off("change", update))

  return signal
}
