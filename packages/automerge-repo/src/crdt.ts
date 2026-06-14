import { next as Automerge } from "@automerge/automerge/slim"
import { hasAtLeastOneKey } from "./helpers/has-at-least-one-key.js"
import { isPlainObject } from "./helpers/isPlainObject.js"
import type { DocumentId, PeerId } from "./types.js"

export type SedimentreeMeta =
  | { kind: "commit"; head: string; parents: string[] }
  | {
      kind: "fragment"
      head: string
      boundary: string[]
      checkpoints: string[]
    }

export type SedimentreeBlob = SedimentreeMeta & { bytes: Uint8Array }

export interface SedimentreeAdapter<State> {
  /** Cheap metadata-only listing so known hashes can be filtered before bytes are bundled. */
  metadata(state: State): Iterable<SedimentreeMeta>

  /** Materialize bytes only for entries selected by SubductionSource. */
  materialize(
    state: State,
    metas: SedimentreeMeta[]
  ): Promise<SedimentreeBlob[]> | SedimentreeBlob[]

  /** Apply inbound commit/fragment blobs and return the updated CRDT state. */
  apply(state: State, blobs: Uint8Array[]): State

  /** Optional storage-side compaction hint. Hashes not returned here may be deleted. */
  liveHashes?(state: State): Iterable<string>
}

export interface DocumentTypeContext {
  documentId: DocumentId
  peerId: PeerId
  crdtName: string
}

export interface DocumentType<State, View, Change, Init> {
  readonly name: string

  /** Empty local state for a find/load path before any data has arrived. */
  empty(ctx: DocumentTypeContext): State

  /** Initial state for a locally-created document. */
  init(init: Init, ctx: DocumentTypeContext): State

  /** What DocHandle.doc() returns. */
  view(state: State): View

  /** Apply a typed local change. */
  change(state: State, change: Change, ctx: DocumentTypeContext): State

  /** Current logical heads. Automerge returns hex heads here, not URL heads. */
  heads(state: State): string[]

  /** Used by DocumentQuery; default is heads(state).length > 0. */
  hasData?(state: State): boolean

  /** Optional point-in-time support. */
  viewAt?(state: State, heads: string[]): State
  hasHeads?(state: State, heads: string[]): boolean

  sedimentree: SedimentreeAdapter<State>

  /** Phantom typing only. */
  readonly _types?: {
    state: State
    view: View
    change: Change
    init: Init
  }
}

export type AnyDocumentType = DocumentType<any, any, any, any>

export type StateOf<C> =
  C extends DocumentType<infer State, any, any, any> ? State : Automerge.Doc<C>

export type ViewOf<C> =
  C extends DocumentType<any, infer View, any, any>
    ? View
    : Automerge.Doc<NonNullable<C>> | Extract<C, undefined>

export type ChangeOf<C> =
  C extends DocumentType<any, any, infer Change, any>
    ? Change
    : Automerge.ChangeFn<C>

export type InitOf<C> =
  C extends DocumentType<any, any, any, infer Init> ? Init : C | undefined

export type AutomergeDocType<T> = DocumentType<
  Automerge.Doc<T>,
  Automerge.Doc<NonNullable<T>> | Extract<T, undefined>,
  Automerge.ChangeFn<T>,
  T | undefined
> & { readonly kind: "automerge" }

export function defineDocumentType<State, View, Change, Init>(
  type: DocumentType<State, View, Change, Init>
): DocumentType<State, View, Change, Init> {
  return type
}

export function isDocumentType(value: unknown): value is AnyDocumentType {
  return (
    typeof value === "object" &&
    value !== null &&
    "empty" in value &&
    "init" in value &&
    "view" in value &&
    "change" in value &&
    "heads" in value &&
    "sedimentree" in value
  )
}

export function automergeDocType<T = unknown>(
  name = "automerge"
): AutomergeDocType<T> {
  return {
    name,
    kind: "automerge",
    empty: () => Automerge.init<T>(),
    init: initialValue => {
      // Preserve Repo.create's historical behavior: only non-empty plain
      // objects are passed to Automerge.from; other values create an empty
      // Automerge document with one empty change.
      if (isPlainObject(initialValue) && hasAtLeastOneKey(initialValue)) {
        return Automerge.from(initialValue as any) as Automerge.Doc<T>
      }
      return Automerge.emptyChange(Automerge.init<T>()) as Automerge.Doc<T>
    },
    view: state =>
      state as Automerge.Doc<NonNullable<T>> | Extract<T, undefined>,
    change: (state, change) =>
      Automerge.change(
        state,
        change as Automerge.ChangeFn<T>
      ) as Automerge.Doc<T>,
    heads: state => Automerge.getHeads(state),
    hasData: state => Automerge.getHeads(state).length > 0,
    viewAt: (state, heads) => Automerge.view(state, heads) as Automerge.Doc<T>,
    hasHeads: (state, heads) => Automerge.hasHeads(state, heads),
    sedimentree: {
      metadata: state => {
        const commits = Automerge.getFragmentMetadata(state, 0).map(m => ({
          kind: "commit" as const,
          head: m.head,
          parents: m.boundary,
        }))
        const fragments = Automerge.getFragmentMetadata(state, {
          start: 1,
        }).map(m => ({
          kind: "fragment" as const,
          head: m.head,
          boundary: m.boundary,
          checkpoints: m.checkpoints,
        }))
        return [...commits, ...fragments]
      },
      materialize: (state, metas) => {
        const requested = new Set(metas.map(m => m.head))
        const commitMetas = Automerge.getFragmentMetadata(state, 0).filter(m =>
          requested.has(m.head)
        )
        const fragmentMetas = Automerge.getFragmentMetadata(state, {
          start: 1,
        }).filter(m => requested.has(m.head))

        const commitBytes =
          commitMetas.length === 0
            ? []
            : Automerge.bundleFragmentMetadata(state, commitMetas)
        const fragmentBytes =
          fragmentMetas.length === 0
            ? []
            : Automerge.bundleFragmentMetadata(state, fragmentMetas)

        return [
          ...commitMetas.map((m, i) => ({
            kind: "commit" as const,
            head: m.head,
            parents: m.boundary,
            bytes: commitBytes[i],
          })),
          ...fragmentMetas.map((m, i) => ({
            kind: "fragment" as const,
            head: m.head,
            boundary: m.boundary,
            checkpoints: m.checkpoints,
            bytes: fragmentBytes[i],
          })),
        ]
      },
      apply: (state, blobs) => Automerge.loadIncremental(state, concat(blobs)),
      liveHashes: state => [
        ...Automerge.getFragmentMetadata(state, 0).map(m => m.head),
        ...Automerge.getFragmentMetadata(state, { start: 1 }).map(m => m.head),
      ],
    },
  }
}

function concat(blobs: Uint8Array[]): Uint8Array {
  if (blobs.length === 1) return blobs[0]
  const total = blobs.reduce((n, blob) => n + blob.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const blob of blobs) {
    out.set(blob, offset)
    offset += blob.byteLength
  }
  return out
}
