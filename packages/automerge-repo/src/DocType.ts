import type { BinaryDocumentId, DocumentId, RepoId, UrlHeads } from "./types.js"
import type { DocumentState } from "./DocumentState.js"
import type { AnyHandle, Handle, HandleOptions } from "./Handle.js"
import type { DocTypeHelpers } from "./docTypeKinds.js"
import type {
  CommitId,
  FragmentRecord,
  RecordBatch,
} from "./sedimentree/index.js"

export type {
  DocTypeHelpers,
  HandleFor,
  HandleKind,
  HandleOfClass,
  InitOf,
  Kinded,
  KindOf,
  Of,
  PlainHandle,
  SchemeOf,
  ShapeOf,
  Shaped,
} from "./docTypeKinds.js"

/** A class of handles: constructed by the Repo, never by apps. */
export type HandleClass = new (
  state: DocumentState,
  options?: HandleOptions
) => Handle<any, any, any>

/** What a document type is told about the document it is working on. */
export interface DocTypeContext {
  readonly documentId: DocumentId
  /** This replica: each Repo is one. */
  readonly repoId: RepoId
}

/** What {@link DocType.openUrl} asks the Repo to open for a URL. */
export interface UrlTarget {
  /** The document's ID (32-byte binary or base58check-encoded string). */
  documentId: DocumentId | BinaryDocumentId
  /** Wait until these heads are in the document's history, then open a view. */
  heads?: UrlHeads
  /** Derive a handle from the ready root (or view) handle. */
  open?(handle: AnyHandle): AnyHandle
}

/**
 * A kind of document: how its state is built from, and turned into,
 * sedimentree records, and how it is read and changed. Repo is otherwise
 * ignorant of the state's shape. Automerge is the default type.
 *
 * States may be immutable snapshots (Automerge) or changed in place: Repo
 * reads heads before running a change and never keeps an old state.
 *
 * Heads and commit IDs are lowercase hex; every state's commit graph is a
 * sedimentree.
 */
export interface DocType<
  State,
  View = State,
  Change = unknown,
  Init = unknown,
  Scheme extends string = string,
  H extends HandleClass | undefined = HandleClass | undefined,
> {
  /** The type's URL scheme and identity, e.g. `gcounter`: written in its
   * documents' URLs (`gcounter:<id>`). Lowercase RFC 3986 scheme (letter,
   * then letters, digits, `+`, `.`, `-`); `automerge` is Automerge's. */
  readonly scheme: Scheme

  /** A new document's state, with at least one commit. Its ID is not
   * known yet: the backend allocates it from the first records. */
  create(init: Init, context: Pick<DocTypeContext, "repoId">): State

  /** What `handle.doc()` returns. */
  value(state: State): View

  /** Apply a local change. May return `state` changed in place. */
  change(state: State, change: Change, context: DocTypeContext): State

  /** Apply trusted records, retaining any whose parents are missing until
   * they arrive. `state` is undefined on the first load; no records then
   * gives an empty state. May return `state` changed in place. */
  apply(state: State | undefined, records: RecordBatch): State

  heads(state: State): string[]

  /** Whether `heads` are all applied, excluding pending changes. */
  hasHeads(state: State, heads: readonly string[]): boolean

  /** History outside `heads` as records: loose commits, plus fragments
   * where the type has them at hand. With no heads, the whole history. */
  recordsSince(state: State, heads: readonly string[]): RecordBatch

  /** Fragments headed by these boundary commits. Heads without a fragment
   * of their own are `absent`. Without this, nothing is compacted. */
  fragments?(
    state: State,
    heads: Iterable<CommitId>
  ): { records: FragmentRecord[]; absent: CommitId[] }

  /** The state as of `heads`, for read-only views. Without this, there are
   * no views. */
  view?(state: State, heads: readonly string[]): State

  /** Bring `other`'s history into `state`. Defaults to applying all of
   * `other`'s records. */
  merge?(state: State, other: State): State

  /**
   * The class of this type's handles: {@link Handle}, or a subclass with
   * the type's reading and editing API. Defaults to `Handle`.
   */
  readonly handle?: H

  /**
   * Parse and open a URL of this type's scheme (`<scheme>:...`). Called
   * synchronously before opening the document, so malformed URLs fail
   * immediately. Defaults to `<scheme>:<base58DocumentId>`.
   */
  openUrl?(url: string): UrlTarget

  /**
   * Format the URL returned by {@link Handle.url} (must start with
   * `<scheme>:`). Paired with `openUrl`. Defaults to
   * `<scheme>:<base58DocumentId>`.
   */
  formatUrl?(handle: AnyHandle): string
}

export type AnyDocType = DocType<any, any, any, any, string, any>

/**
 * Infer a type's parameters, and its handle class if given, from its
 * definition. `View` and `Change` come from the type's `value` and `change`;
 * the class's `doc()` may return `View | undefined` (for handles that may not
 * resolve) and its `change()` must accept `Change`.
 */
export function defineDocType<
  State,
  View,
  Change,
  Init,
  const Scheme extends string,
  H extends HandleClass,
>(
  type: DocType<State, View, Change, Init, Scheme, H> & {
    readonly handle: H &
      (new (
        ...args: any[]
      ) => Handle<NoInfer<View> | undefined, NoInfer<Change>, any>)
  }
): DocType<State, View, Change, Init, Scheme, H> & {
  readonly handle: H
} & DocTypeHelpers<
    InstanceType<H>,
    Scheme,
    DocType<State, View, Change, Init, Scheme, H> & { readonly handle: H }
  >
export function defineDocType<
  State,
  View,
  Change,
  Init,
  const Scheme extends string,
>(
  type: DocType<State, View, Change, Init, Scheme, undefined> & {
    readonly handle?: undefined
  }
): DocType<State, View, Change, Init, Scheme, undefined> &
  DocTypeHelpers<
    Handle<View, Change>,
    Scheme,
    DocType<State, View, Change, Init, Scheme, undefined>
  >
export function defineDocType(
  type: AnyDocType
): AnyDocType & DocTypeHelpers<Handle<any, any, any>, string, AnyDocType> {
  const self = function (this: unknown) {
    return this
  }
  // Type-level only: return the same object, so Repo sees one doc type.
  return Object.defineProperties(type, {
    as: { value: self, configurable: true },
    of: { value: self, configurable: true },
  }) as AnyDocType & DocTypeHelpers<Handle<any, any, any>, string, AnyDocType>
}

/** `other`'s history added to `state`, with the type's `merge` if it has one. */
export function mergeStates<State>(
  type: DocType<State, any, any, any, string>,
  state: State,
  other: State
): State {
  return type.merge
    ? type.merge(state, other)
    : type.apply(state, type.recordsSince(other, []))
}

/** Throws unless the type has views. */
export function requireView(type: AnyDocType): void {
  if (!type.view) throw new Error(`${type.scheme} documents have no views`)
}
