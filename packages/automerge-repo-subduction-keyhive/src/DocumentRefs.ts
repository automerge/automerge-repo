import {
  checkpointForCommit,
  idBytes,
  type CommitId,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"
import { ChangeId, Encrypted } from "@keyhive/keyhive/slim"
import { uint8ArrayToHex } from "./utilities.js"

/**
 * A record's keyhive content ref as hex. A commit's is its id, the hash of
 * its change. A fragment's is keyhive's ref for its plaintext, from
 * `ChangeId.forContent`, so it differs from the id of the commit at its head.
 */
export type ContentRef = string & { readonly __contentRef: unique symbol }

export function contentRef(bytes: Uint8Array): ContentRef {
  return uint8ArrayToHex(bytes) as ContentRef
}

export function recordRef(record: SedimentreeRecord): ContentRef {
  if (record.kind === "commit") return record.id as string as ContentRef
  const ref = ChangeId.forContent(record.blob)
  try {
    return contentRef(ref.toBytes())
  } finally {
    ref.free()
  }
}

/**
 * The hashes of the changes in a blob and the changes outside it that they
 * depend on. `undefined` if the blob is not valid content.
 */
export type ChangesIn = (
  blob: Uint8Array
) => { hashes: CommitId[]; deps: CommitId[] } | undefined

/**
 * The hashes of the changes in a decrypted record's blob. `undefined` if
 * the blob is not the content its metadata describes. A commit's change must
 * hash to its id and depend on exactly its parents. A fragment's bundle must
 * contain its head and a change for each checkpoint, must not contain its
 * boundary, and must depend on changes outside it exactly when the boundary
 * is not empty. The boundary is the fragment's parents among fragments.
 * The bundle's dependencies are in the boundary's history but need not equal
 * it. Keyhive binds a ciphertext to the content ref in its header but not to
 * the record that contains it. A writer could otherwise put any change under
 * an existing commit's id.
 */
export function matchingChanges(
  record: SedimentreeRecord,
  changesIn: ChangesIn
): CommitId[] | undefined {
  const content = changesIn(record.blob)
  if (!content) return undefined
  const { hashes, deps } = content
  const matches =
    record.kind === "commit"
      ? hashes.length === 1 &&
        hashes[0] === record.id &&
        sameIds(deps, record.parents)
      : hashes.includes(record.head) &&
        !record.boundary.some(id => hashes.includes(id)) &&
        (deps.length === 0) === (record.boundary.length === 0) &&
        record.checkpoints.every(checkpoint =>
          hashes.some(hash => checkpointForCommit(hash) === checkpoint)
        )
  return matches ? hashes : undefined
}

function sameIds(ids: readonly CommitId[], expected: readonly CommitId[]) {
  const actual = new Set(ids)
  return (
    actual.size === new Set(expected).size &&
    expected.every(id => actual.has(id))
  )
}

/** The content ref in a ciphertext's header. Throws if `blob` is not a keyhive
 * ciphertext. */
export function ciphertextRef(blob: Uint8Array): ContentRef {
  const encrypted = Encrypted.fromBytes(blob)
  try {
    return contentRef(encrypted.contentRef())
  } finally {
    encrypted.free()
  }
}

/** The ref in a stored ciphertext's header. `undefined` if `blob` is not
 * keyhive ciphertext. */
export function storedRef(blob: Uint8Array): ContentRef | undefined {
  try {
    return ciphertextRef(blob)
  } catch {
    return undefined
  }
}

export function refBytes(ref: ContentRef): Uint8Array {
  return idBytes(ref as string as CommitId)
}

interface KnownFragment {
  readonly head: CommitId
  /** The number of leading zero bytes of its head. */
  readonly level: number
}

/** Fragments by ref with the commits each contains. */
export class FragmentIndex {
  readonly #fragments = new Map<ContentRef, KnownFragment>()
  /** The refs of the fragments that contain each commit. */
  readonly #containing = new Map<CommitId, ContentRef[]>()

  add(ref: ContentRef, head: CommitId, commits: Iterable<CommitId>): void {
    if (this.#fragments.has(ref)) return
    this.#fragments.set(ref, {
      head,
      level: /^(?:00)*/.exec(head)![0].length / 2,
    })
    for (const commit of commits) {
      const refs = this.#containing.get(commit)
      if (refs) refs.push(ref)
      else this.#containing.set(commit, [ref])
    }
  }

  head(ref: ContentRef): CommitId | undefined {
    return this.#fragments.get(ref)?.head
  }

  /**
   * The deepest fragment here that contains `commit` among those `include`
   * accepts.
   */
  deepestContaining(
    commit: CommitId,
    include: (ref: ContentRef) => boolean = () => true
  ): ContentRef | undefined {
    let deepest: ContentRef | undefined
    let level = -1
    for (const ref of this.#containing.get(commit) ?? []) {
      const fragment = this.#fragments.get(ref)!
      if (fragment.level > level && include(ref)) {
        deepest = ref
        level = fragment.level
      }
    }
    return deepest
  }
}

/**
 * Keyhive content refs of one document's records.
 */
export class DocumentRefs {
  /**
   * Refs of this replica's writes that no session of this document has
   * received back from the inner backend yet.
   */
  readonly #ownWrites = new Set<ContentRef>()
  /**
   * Fragments this replica has encrypted or decrypted. Keyhive keeps the key
   * in both cases. A later write can list one as a predecessor.
   */
  readonly fragments = new FragmentIndex()

  addOwnWrite(ref: ContentRef): void {
    this.#ownWrites.add(ref)
  }

  /** Whether `ref` is an own write not reported back yet. */
  isOwnWrite(ref: ContentRef): boolean {
    return this.#ownWrites.has(ref)
  }

  /** Forget the own write `ref`. */
  forgetOwnWrite(ref: ContentRef): void {
    this.#ownWrites.delete(ref)
  }

  dropOwnWrites(): void {
    this.#ownWrites.clear()
  }
}
