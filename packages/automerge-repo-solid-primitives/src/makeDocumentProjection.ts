import { onCleanup, createProjection, Store } from "solid-js"
import type {
  Doc,
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo/slim"

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

  let p = Promise.withResolvers<DocHandleChangePayload<T>>()
  function onchange(payload: DocHandleChangePayload<T>) {
    p.resolve(payload)
  }
  handle.on("change", onchange)

  const doc = createProjection<T>(
    async function* (doc) {
      yield doc
      while (true) {
        const payload = await p.promise
        yield applyPatches(doc, payload.patches)
        p = Promise.withResolvers<DocHandleChangePayload<T>>()
      }
    },
    initial(handle),
    { name: `Projection(${handle.url})` }
  )

  cache.set(handle, {
    refs: 0,
    store: doc,
    cleanup() {
      handle.off("change", onchange)
      handle.off("delete", ondelete)
      // https://github.com/chee/solid-automerge/pull/5
      cache.delete(handle)
    },
  })

  function ondelete() {}

  handle.on("change", onchange)
  handle.on("delete", ondelete)

  return doc
}
