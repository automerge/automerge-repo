import { next as A } from "@automerge/automerge/slim"
import { defineDocType } from "../DocType.js"
import { isPlainObject } from "../helpers/isPlainObject.js"
import { concatBytes } from "../sedimentree/concatBytes.js"
import {
  extractCommitsSince,
  extractFragments,
  extractRecords,
} from "../sedimentree/automerge/index.js"

/** The default document type: Automerge. */
export const automerge = defineDocType({
  scheme: "automerge",
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
  merge: (doc, other) => A.merge(doc, A.clone(other)),
})

export type AutomergeDocType = typeof automerge
