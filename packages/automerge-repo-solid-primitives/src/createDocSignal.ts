import { createEffect, onCleanup, type Accessor } from "solid-js"
import { createSignal } from "solid-js"
import type { Doc, DocHandle, Handle } from "@automerge/automerge-repo/slim"
import type { ValueOf } from "./types.js"

/**
 * a light coarse-grained primitive when you care only _that_ a doc has changed,
 * and not _how_. works with {@link useDocHandle}, and with handles of any doc
 * type.
 * @param handle an accessor (signal/resource) of a
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function createDocSignal<H extends Handle<any, any, any>>(
  handle: Accessor<H | undefined>
): Accessor<ValueOf<H> | undefined>
export default function createDocSignal<T extends object>(
  handle: Accessor<DocHandle<T> | undefined>
): Accessor<Doc<T> | undefined>
export default function createDocSignal(
  handle: Accessor<Handle<any, any, any> | undefined>
): Accessor<unknown> {
  const [signal, setSignal] = createSignal<unknown>(handle()?.doc())

  createEffect(() => {
    const h = handle()

    function update() {
      setSignal(() => h?.doc())
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
