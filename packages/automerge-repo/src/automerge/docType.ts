import { next as A } from "@automerge/automerge/slim"
import { defineDocType, type Shaped, type UrlTarget } from "../DocType.js"
import { concatBytes } from "../sedimentree/concatBytes.js"
import {
  extractCommitsSince,
  extractFragments,
  extractRecords,
} from "../sedimentree/automerge/index.js"
import { AutomergeHandle } from "./handle.js"
import { withPatchSource } from "./helpers.js"
import { parseAutomergeUrl, type AutomergeUrl } from "./url.js"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Automerge's handles: generic in the document's shape, and passing the
 * backend's extensions on to sub-handles. */
export interface AutomergeKind extends Shaped {
  readonly scheme: "automerge"
  readonly handle: AutomergeHandle<this["Shape"]>
  readonly init: this["Shape"] | undefined
}

/** The default document type: Automerge, behind an `AutomergeHandle`. */
export const automerge = defineDocType({
  scheme: "automerge",
  // Non-empty plain objects seed the document via `A.from`; empty objects and
  // other values start with an empty change instead (avoiding `A.from({})`) so
  // the new document has a head.
  create: (init: unknown): A.Doc<any> =>
    isPlainObject(init) && Object.keys(init).length
      ? A.from(init)
      : A.emptyChange(A.init()),
  value: (doc: A.Doc<any>) => doc,
  change: (doc: A.Doc<any>, fn: A.ChangeFn<any>) => A.change(doc, fn),
  apply: (doc: A.Doc<any> | undefined, records) => {
    if (!records.length) return doc ?? A.init()
    const bytes = concatBytes(records.map(record => record.blob))
    // On first load, construct the document directly rather than incrementally.
    // Allow missing parents so records from an interrupted sync or crash stay
    // pending while the complete prefix loads.
    const next = doc
      ? A.loadIncremental(doc, bytes)
      : A.load(bytes, { allowMissingChanges: true })
    return next === doc ? next : withPatchSource(next, "loadIncremental")
  },
  heads: doc => A.getHeads(doc),
  hasHeads: (doc, heads) => A.hasHeads(doc, [...heads]),
  // The whole history as Automerge's covering fragments; a delta as loose commits.
  recordsSince: (doc, heads) =>
    heads.length ? extractCommitsSince(doc, heads) : extractRecords(doc),
  fragments: extractFragments,
  view: (doc, heads) => A.view(doc, [...heads]),
  merge: (doc, other) => {
    const next = A.merge(doc, other)
    return next === doc ? next : withPatchSource(next, "merge")
  },
  handle: AutomergeHandle,
  // Formatting lives on `AutomergeHandle.url`, which reads the handle's private
  // path, range and heads.
  openUrl: url => {
    const { documentId, heads, segments } = parseAutomergeUrl(
      url as AutomergeUrl
    )
    const target: UrlTarget = { documentId }
    if (heads !== undefined) target.heads = heads
    if (segments !== undefined) {
      target.open = handle =>
        (handle as AutomergeHandle<any>).sub(...(segments as any[]))
    }
    return target
  },
}).as<AutomergeKind>()

/** The default document type: Automerge, behind an `AutomergeHandle`. */
export type AutomergeDocType = typeof automerge
