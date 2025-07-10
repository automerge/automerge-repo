import { onCleanup } from "solid-js"
import type {
  Doc,
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo/slim"
import autoproduce from "./autoproduce.js"
import { createStore, produce, reconcile, type Store } from "solid-js/store"
import { applyPatches, diff, getHeads } from "@automerge/automerge/slim"

const cache = new WeakMap<
  DocHandle<unknown>,
  {
    refs: number
    store: Store<Doc<unknown>>
    cleanup(): void
  }
>()

function initial<T>(handle: DocHandle<T>): T {
  const template = {} as T
  applyPatches(template, diff(handle.doc(), [], getHeads(handle.doc())))
  return template
}

/**
 * make a fine-grained live view of a document from its handle.
 * @param handle an Automerge
 * [DocHandle](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.DocHandle.html)
 */
export default function makeDocumentProjection<T extends object>(
  handle: DocHandle<T>
): Doc<T> {
  onCleanup(() => {
    const item = cache.get(handle)!
    if (!item) return
    if (!item.refs--) {
      item.cleanup()
    }
  })

  if (cache.has(handle)) {
    const item = cache.get(handle)!
    item.refs++
    return item.store as T
  }

  const [doc, set] = createStore<T>(initial(handle))

  cache.set(handle, {
    refs: 0,
    store: doc,
    cleanup() {
      handle.off("change", patch)
      handle.off("delete", ondelete)
      // https://github.com/chee/solid-automerge/pull/5
      cache.delete(handle)
    },
  })

  function patch(payload: DocHandleChangePayload<T>) {
    set(produce(autoproduce(payload)))
  }

  function ondelete() {
    set(reconcile({} as T))
  }

  handle.on("change", patch)
  handle.on("delete", ondelete)

  return doc
}
