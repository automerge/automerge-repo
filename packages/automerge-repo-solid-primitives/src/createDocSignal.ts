import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createSignal } from "solid-js"
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
  const [signal, setSignal] = createSignal<Doc<T> | undefined>(handle()?.doc())

  createEffect(() => {
    const h = handle()

    function update() {
      setSignal(() => h?.doc() as Doc<T> | undefined)
    }

    // sync the signal with the current handle's doc
    update()

    if (h) {
      h.on("change", update)
      onCleanup(() => h.off("change", update))
    }
  })

  return signal
}
