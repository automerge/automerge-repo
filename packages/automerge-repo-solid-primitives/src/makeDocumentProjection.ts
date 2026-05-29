import { onCleanup } from "solid-js"
import type {
  Doc,
  DocHandle,
  DocHandleChangePayload,
  UrlHeads,
} from "@automerge/automerge-repo/slim"
import autoproduce from "./autoproduce.js"
import { createStore, produce, reconcile, type Store } from "solid-js/store"
import { applyPatches } from "@automerge/automerge/slim"

const cache = new WeakMap<
  DocHandle<unknown>,
  {
    refs: number
    store: Store<Doc<unknown>>
    cleanup(): void
  }
>()

/**
 * Materialize the handle's (scoped) value into a fresh, owned plain object.
 * `handle.diff` returns patches relative to the handle's scope and evaluated
 * at the handle's own heads, so this is correct for sub-handles and
 * view-pinned (heads) handles alike.
 */
function initial<T>(handle: DocHandle<T>): T {
  const template = {} as T
  const patches = handle.diff([] as unknown as UrlHeads, handle.heads())
  applyPatches(template as object, patches)
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
    // The payload is already scoped to this handle: patch paths are relative
    // to its sub-tree and `scopeReplaced` flags a wholesale change at/above
    // the scope boundary (reconcile from the scoped value in that case).
    if (payload.scopeReplaced) {
      set(reconcile((payload.doc ?? {}) as T))
      return
    }
    set(produce(autoproduce(payload)))
  }

  function ondelete() {
    set(reconcile({} as T))
  }

  handle.on("change", patch)
  handle.on("delete", ondelete)

  return doc
}
