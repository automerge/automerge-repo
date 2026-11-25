import {
  checkpointForCommit,
  idBytes,
  type CheckpointId,
  type CommitId,
  type FragmentRecord,
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

/** Fragments by ref along with the boundary commits each is known to contain. */
export class FragmentIndex {
  readonly #fragments = new Map<ContentRef, KnownFragment>()
  /** The refs of the fragments with each head or checkpoint. */
  readonly #containing = new Map<CommitId | CheckpointId, ContentRef[]>()

  add(
    ref: ContentRef,
    fragment: Pick<FragmentRecord, "head" | "checkpoints">
  ): void {
    if (this.#fragments.has(ref)) return
    const { head, checkpoints } = fragment
    this.#fragments.set(ref, {
      head,
      level: /^(?:00)*/.exec(head)![0].length / 2,
    })
    for (const key of [head, ...checkpoints]) {
      const refs = this.#containing.get(key)
      if (refs) refs.push(ref)
      else this.#containing.set(key, [ref])
    }
  }

  head(ref: ContentRef): CommitId | undefined {
    return this.#fragments.get(ref)?.head
  }

  /**
   * The deepest fragment here that is known to contain `commit`, among those
   * `include` accepts.
   */
  deepestContaining(
    commit: CommitId,
    include: (ref: ContentRef) => boolean = () => true
  ): ContentRef | undefined {
    let deepest: ContentRef | undefined
    let level = -1
    const refs = [
      ...(this.#containing.get(commit) ?? []),
      ...(this.#containing.get(checkpointForCommit(commit)) ?? []),
    ]
    for (const ref of refs) {
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
