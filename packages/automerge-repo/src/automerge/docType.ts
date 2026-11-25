import { next as A } from "@automerge/automerge/slim"
import type { DocType, Of, Shaped } from "../DocType.js"
import { isPlainObject } from "../helpers/isPlainObject.js"
import { concatBytes } from "../sedimentree/concatBytes.js"
import {
  extractCommitsSince,
  extractFragments,
  extractRecords,
} from "../sedimentree/automerge/index.js"
import { parsePath } from "../subdoc-handles/parser.js"
import { AutomergeHandle } from "./handle.js"

/** The default document type: Automerge, behind an {@link AutomergeHandle}. */
export interface AutomergeDocType extends DocType<
  A.Doc<any>,
  A.Doc<any>,
  A.ChangeFn<any>,
  unknown,
  "automerge"
> {
  readonly handle: typeof AutomergeHandle
  readonly "~kind"?: AutomergeKind
  /** This doc type, for documents of shape `T`. Type-level only:
   * `find(url, { docType: automerge.of<T>() })` is `find<T>(url)`. */
  of<T>(): Of<AutomergeDocType, T>
}

/** Automerge's handles: generic in the document's shape, and passing the
 * backend's extensions on to sub-handles. */
export interface AutomergeKind extends Shaped {
  readonly name: "automerge"
  readonly handle: AutomergeHandle<this["Shape"]>
  readonly init: this["Shape"] | undefined
}

/** The default document type: Automerge. */
export const automerge: AutomergeDocType = {
  name: "automerge",
  // Only non-empty plain objects seed a document; anything else starts it
  // empty, with one empty change so it has a head.
  create: (init: unknown): A.Doc<any> =>
    isPlainObject(init) && Object.keys(init).length
      ? A.from(init)
      : A.emptyChange(A.init()),
  value: (doc: A.Doc<any>) => doc,
  change: (doc: A.Doc<any>, fn: A.ChangeFn<any>) => A.change(doc, fn),
  // The first load can become the document directly. A crash mid-flush or an
  // interrupted sync can leave a record without its parents; load the
  // complete prefix and keep the rest pending.
  apply: (doc: A.Doc<any> | undefined, records) => {
    if (!records.length) return doc ?? A.init()
    const bytes = concatBytes(records.map(record => record.blob))
    return doc
      ? A.loadIncremental(doc, bytes)
      : A.load(bytes, { allowMissingChanges: true })
  },
  heads: doc => A.getHeads(doc),
  hasHeads: (doc, heads) => A.hasHeads(doc, [...heads]),
  // The whole history as Automerge's covering fragments; a delta as loose commits.
  recordsSince: (doc, heads) =>
    heads.length ? extractCommitsSince(doc, heads) : extractRecords(doc),
  fragments: extractFragments,
  view: (doc, heads) => A.view(doc, [...heads]),
  merge: (doc, other) => A.merge(doc, other),
  handle: AutomergeHandle,
  openPath: (handle, path) =>
    (handle as AutomergeHandle<any>).sub(...(parsePath(path) as any[])),
  of() {
    return this
  },
}

/** @internal Independent copy of an Automerge state (for `Repo.clone` and merges). */
export const cloneAutomerge = (doc: unknown): A.Doc<any> =>
  A.clone(doc as A.Doc<any>)

/** @internal Decode an Automerge document binary (for `Repo.import`). */
export const loadAutomerge = (binary: Uint8Array): A.Doc<any> => A.load(binary)

/** @internal Encode an Automerge state as a binary (for `Repo.export`). */
export const saveAutomerge = (doc: unknown): Uint8Array =>
  A.save(doc as A.Doc<any>)

/** @internal Ensure an Automerge state has at least one commit before creating
 * a new document on the backend. */
export const ensureAutomergeCommit = (doc: unknown): A.Doc<any> => {
  const current = doc as A.Doc<any>
  return A.getHeads(current).length ? current : A.emptyChange(current)
}
