import { next as A } from "@automerge/automerge/slim"

/** @internal An Automerge document state, kept opaque to `Repo`. */
export type AutomergeDoc = A.Doc<any>

/** @internal Independent copy of an Automerge document (for `Repo.clone` and merges). */
export const cloneAutomerge = (doc: AutomergeDoc): AutomergeDoc => A.clone(doc)

/** @internal Decode an Automerge document binary (for `Repo.import`). */
export const loadAutomerge = (binary: Uint8Array): AutomergeDoc =>
  A.load(binary)

/** @internal Encode an Automerge document as a binary (for `Repo.export`). */
export const saveAutomerge = (doc: AutomergeDoc): Uint8Array => A.save(doc)

/** @internal Ensure an Automerge document has at least one commit before creating
 * a new document on the backend. */
export const ensureAutomergeCommit = (doc: AutomergeDoc): AutomergeDoc =>
  A.getHeads(doc).length ? doc : A.emptyChange(doc)
