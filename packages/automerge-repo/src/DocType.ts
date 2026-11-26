import type { BinaryDocumentId, DocumentId, RepoId, UrlHeads } from "./types.js"
import type { DocumentState } from "./DocumentState.js"
import type { AnyHandle, Handle, HandleOptions } from "./Handle.js"
import type {
  CommitId,
  FragmentRecord,
  RecordBatch,
} from "./sedimentree/index.js"

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
 * What handles a doc type gives, as one declaration: its `handle` names the
 * handle class, with `this["Shape"]` for the document's shape if the class
 * takes one. It also names the doc type: handles show as
 * `DocHandle<Todo, X, Register>`. The backend's extensions are added to every
 * handle; see {@link DocHandle}.
 *
 * ```ts
 * export interface GCounter extends HandleKind {
 *   readonly scheme: "gcounter"
 *   readonly handle: CounterHandle
 * }
 * export const gcounter = defineDocType({ …, handle: CounterHandle }).as<GCounter>()
 * ```
 *
 * A doc type whose handles are generic in the shape extends {@link Shaped}.
 */
export interface HandleKind {
  /** The doc type's URL scheme, as its definition gives it: handles' URLs are
   * typed with it (`DocumentUrl<"gcounter">`). */
  readonly scheme: string
  /** Filled in by the library: the document's shape, as `of<Shape>()` gives
   * it. Read it in `handle` as `this["Shape"]`. */
  readonly Shape: unknown
  readonly handle: Handle<any, any, any>
  /** What `create` takes, if not what the doc type's `create` takes. */
  readonly init?: unknown
}

/**
 * A {@link HandleKind} whose handles are generic in the document's shape.
 * Its doc type gains `of<T>()`, which users pass to `find` and `create`:
 *
 * ```ts
 * export interface Register extends Shaped {
 *   readonly scheme: "register"
 *   readonly handle: RegisterHandle<this["Shape"]>
 *   readonly init: this["Shape"] // optional: what `create` takes
 * }
 * export const register = defineDocType({ …, handle: RegisterHandle }).as<Register>()
 * await repo.find(url, { docType: register.of<Todo>() })
 * ```
 *
 * TypeScript can't apply a shape to a class held in a value; this tells it how.
 */
export interface Shaped extends HandleKind {
  readonly "~shaped": true
}

/** The handles of a doc type with scheme `Scheme` and this class, and no
 * {@link HandleKind}. */
export interface HandleOfClass<
  C extends HandleClass,
  Scheme extends string = string,
> extends HandleKind {
  readonly scheme: Scheme
  readonly handle: InstanceType<C>
}

/** The handles of a doc type with scheme `Scheme` and no class: the base
 * `Handle`, typed from the doc type's `value` and `change`. */
export interface PlainHandle<
  V,
  C,
  Scheme extends string = string,
> extends HandleKind {
  readonly scheme: Scheme
  readonly handle: Handle<V, C>
}

/** The handle `K` gives for shape `T`. */
export type HandleFor<K extends HandleKind, T> = (K & {
  readonly Shape: T
})["handle"]

/** A doc type `D`, for documents of shape `T`: what `of` gives. */
export type Of<D, T> = D & { readonly "~shape"?: T }

/** The document shape a doc type was given with `of`. */
export type ShapeOf<D> = D extends { readonly "~shape"?: infer T } ? T : unknown

/** What a doc type says its handles are with `as`. */
export type Kinded<D, K extends HandleKind> = D & {
  readonly "~kind"?: K
} & (K extends Shaped
    ? {
        /** This doc type, for documents of shape `T`. Type-level only. */
        of<T>(): Of<D & { readonly "~kind"?: K }, T>
      }
    : {})

/** The handles a doc type gives: what it says with `as`, or else its class,
 * or else the base `Handle`. */
export type KindOf<D> = D extends { readonly "~kind"?: infer K }
  ? [K] extends [HandleKind]
    ? K
    : DefaultKind<D>
  : DefaultKind<D>

type DefaultKind<D> =
  D extends DocType<any, infer V, infer C, any, infer Scheme, infer H>
    ? H extends HandleClass
      ? HandleOfClass<H, Scheme>
      : PlainHandle<V, C, Scheme>
    : never

/** A doc type's URL scheme, as a literal type when its definition gives one. */
export type SchemeOf<D> = D extends { readonly scheme: infer S extends string }
  ? S
  : string

/** What `create` takes for a doc type and shape `T`: what its
 * {@link HandleKind} says, if it says (`readonly init: this["Shape"]`),
 * otherwise what the type's `create` takes. */
export type InitOf<D, T = ShapeOf<D>> =
  KindOf<D> extends infer K extends HandleKind & { readonly init: unknown }
    ? (K & { readonly Shape: T })["init"]
    : D extends DocType<any, any, any, infer I, any>
      ? I
      : never

/** What {@link defineDocType} adds to a doc type with scheme `Scheme`, for
 * handles `H`. When `D` is given, `as` returns `Kinded<D, K>` without
 * keeping these helpers on the finished type. */
export interface DocTypeHelpers<
  H extends Handle<any, any, any>,
  Scheme extends string = string,
  D = never,
> {
  /** This doc type, with its handles described by `K` (and named by it).
   * `K`'s handle must be the type's handle class, and its scheme the type's.
   * Type-level only. */
  // `HandleKind` without its `handle`: intersecting that (a `Handle`) with
  // `H` goes too deep for TypeScript, as `url`'s type reads `this`.
  as<
    K extends Omit<HandleKind, "handle" | "scheme"> & {
      readonly handle: H
      readonly scheme: Scheme
    },
  >(): Kinded<[D] extends [never] ? this : D, K>
}

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
