// Compile-time checks of how doc types type handles. Not a test: checked by
// `pnpm lint`.
import { Repo } from "../src/Repo.js"
import { DocHandle, isHandleOf } from "../src/types/DocHandle.js"
import { automerge } from "../src/automerge/docType.js"
import type { AnyDocType } from "../src/DocType.js"
import type { AutomergeUrl } from "../src/types.js"

type Doc = { title: string; items: string[] }

// The default doc type is Automerge: `DocHandle<T>` keeps its whole API.
declare const handle: DocHandle<Doc>
handle.doc()?.title satisfies string | undefined
handle.sub("items", 0).doc() satisfies string | undefined
void handle.change(d => {
  d.title = "x"
})
handle.fullDoc() satisfies { title: string }

// In generic code too: the doc type parameter is concrete, so nothing is
// left unresolved (a conditional on `T` would make `h` a union here).
export function generic<T extends { items: string[] }>(h: DocHandle<T>) {
  h.sub("items").doc()
  h.diff(h.heads())
  h.on("change", ({ patches }) => patches.length)
  const fromRepo: Promise<DocHandle<T>> = new Repo().find<T>("" as AutomergeUrl)
  return fromRepo
}

// A handle of any type has the core API, loosely typed, and no Automerge
// members until narrowed.
declare const any: DocHandle<any, {}, AnyDocType>
any.doc() satisfies any
void any.change(5)
// @ts-expect-error not every type has sub-handles
any.sub("items")
if (isHandleOf(any, automerge))
  any.sub("items")

  // Every handle is a DocHandle at runtime.
;(handle instanceof DocHandle) satisfies boolean
