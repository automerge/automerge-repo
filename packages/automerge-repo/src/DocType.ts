import type { DocumentId, RepoId } from "./types.js"
import type { DocumentState } from "./DocumentState.js"
import type { Handle, HandleOptions } from "./Handle.js"

/** A class of handles: constructed by the Repo, never by apps. */
export type HandleClass = new (
  state: DocumentState<any>,
  options?: HandleOptions
) => Handle<any, any, any>
import type {
  CommitId,
  FragmentRecord,
  RecordBatch,
} from "./sedimentree/index.js"

/** What a document type is told about the document it is working on. */
export interface DocTypeContext {
  readonly documentId: DocumentId
  /** This replica: each Repo is one. */
  readonly repoId: RepoId
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
  /** URL scheme and identity, e.g. `automerge`. */
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

  /** @internal Identity of a handle scope, for caching derived handles. */
  scopeKey?(scope: unknown): string

  /**
   * @internal How a change reaches handles' `change` listeners, in place of
   * sending every writable listening handle `{ handle, doc }`. Called when
   * the change is adopted; the returned function runs in event order.
   */
  changeDispatcher?(
    document: DocumentState<any>,
    change: StateChange<State>
  ): () => void
}

/** @internal A change of state that moved the document's heads. */
export interface StateChange<State> {
  /** Undefined on the first load. May be `after`, changed in place. */
  before: State | undefined
  beforeHeads: string[]
  after: State
  afterHeads: string[]
  /** The first load of a document with no history before it. */
  initial: boolean
}

export type AnyDocType = DocType<any, any, any, any, string, any>

/** What `create` takes for a doc type. */
export type InitOf<D> =
  D extends DocType<any, any, any, infer I, any> ? I : never

/** Infer a type's parameters, and its handle class if given, from its definition. */
export function defineDocType<
  State,
  View,
  Change,
  Init,
  const Scheme extends string,
  H extends HandleClass,
>(
  type: DocType<State, View, Change, Init, Scheme, H> & { readonly handle: H }
): DocType<State, View, Change, Init, Scheme, H> & { readonly handle: H }
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
): DocType<State, View, Change, Init, Scheme, undefined>
export function defineDocType(type: AnyDocType): AnyDocType {
  return type
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
