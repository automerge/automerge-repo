import type { Cursor } from "@automerge/automerge/slim"

/**
 * Symbol used as discriminator for segments to avoid collision with user data.
 * Users might have objects with a 'kind' property in id patterns.
 */
export const KIND = "AUTOMERGE_REF_KIND"

/**
 * Symbol to mark a cursor request for stabilization during sub-handle creation.
 */
export const CURSOR_MARKER = "AUTOMERGE_REF_CURSOR_MARKER"

/**
 * Pattern used to match objects in arrays by their properties.
 * Only primitive values are allowed for reliable serialization and comparison.
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type Pattern = Record<string, string | number | boolean | null>

/**
 * Marker type for cursor-based range that will be stabilized.
 * Created via cursor() function and only valid as the last path argument.
 */
export interface CursorMarker {
  [CURSOR_MARKER]: true
  start: number
  end: number
}

/**
 * Symbolic path segments. A segment names a step into the document - by
 * literal key, literal index, or pattern match against array items - and
 * is *immutable* once constructed. Resolution of a pattern segment to a
 * concrete numeric index happens elsewhere (the handle registry caches
 * it; reads consult or compute it on demand).
 *
 * The matching `prop` value (key string for `"key"`, index number for
 * `"index"` and `"match"`) is exposed via {@link DocHandle.path}, which
 * builds a fresh snapshot on each read. It is *not* stored on the
 * segment itself.
 */
export type PathSegment =
  | { [KIND]: "key"; key: string }
  | { [KIND]: "index"; index: number }
  | { [KIND]: "match"; match: Pattern }

/**
 * Snapshot form of a {@link PathSegment} returned from {@link DocHandle.path}.
 * Each segment carries the same symbolic fields as `PathSegment` plus a
 * `prop` field with its currently-resolved lookup value (key string,
 * literal index, or matched index for patterns; `undefined` for an
 * unmatched pattern).
 */
export type ResolvedPathSegment =
  | { [KIND]: "key"; key: string; prop: string }
  | { [KIND]: "index"; index: number; prop: number }
  | { [KIND]: "match"; match: Pattern; prop: number | undefined }

/** Cursor range segment (always terminal) */
export type CursorRange = { [KIND]: "cursors"; start: Cursor; end: Cursor }

/** All segment types */
export type Segment = PathSegment | CursorRange

/** A codec handles parsing and serialization for one segment type. */
export interface SegmentCodec<K extends Segment[typeof KIND]> {
  kind: K
  /** Does this string match this codec's format? */
  match(s: string): boolean
  /** Parse string to segment (assumes match() returned true) */
  parse(s: string): Extract<Segment, { [KIND]: K }>
  serialize(seg: Extract<Segment, { [KIND]: K }>): string
}

/**
 * Input types that users can provide to create refs.
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type PathInput = string | number | Pattern | CursorMarker

/** Internal: PathInput extended with Segment for URL parsing and internal use */
export type AnyPathInput = PathInput | Segment

/**
 * Mutable text editor passed to a `change` callback when the sub-handle points
 * to a string value (or a cursor range within one).
 *
 * At runtime this is a genuine boxed `String` (`new String(value)`) carrying
 * two extra mutation methods, so it behaves as a real string everywhere
 * (`instanceof String`, `.length`, indexing, every `String.prototype` method)
 * - it extends `String`, not via a proxy. Note: as a boxed string `typeof` is
 * `"object"` and `=== "literal"` is false; use `==`, template strings, or
 * `valueOf()`. It is a snapshot of the value at callback entry.
 *
 * @experimental This API is experimental and may change in future versions.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export interface MutableText extends String {
  /** Splice text at a position - uses Automerge.splice for CRDT-safe mutation */
  splice(index: number, deleteCount: number, insert?: string): void
  /** Replace entire text content - uses Automerge.updateText for CRDT-safe mutation */
  updateText(newValue: string): void
}

/**
 * Change callback for a sub-handle's `change()`. Mutate primitives by
 * returning a new value; mutate objects and arrays in place. Strings
 * receive a {@link MutableText} wrapper exposing CRDT-safe `splice` and
 * `updateText` methods.
 *
 * Distinct from `Automerge.ChangeFn` (which is unscoped and operates on
 * the whole document). Re-exported from the package as `SubChangeFn`.
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type SubChangeFn<T> = (
  val: NonNullable<T> extends string ? MutableText : NonNullable<T>
) => T | void

/**
 * Step one segment into `TObj`, stripping nullability on the *parent*
 * first so traversal continues through optional intermediates. Returns
 * the raw value type for the step - optional-key `undefined` is preserved,
 * but array-index / pattern hops return the bare element (their
 * possible-absence is folded in separately by {@link HopCanBeAbsent}).
 */
type StepValue<TObj, TSegment> = NonNullable<TObj> extends infer O
  ? TSegment extends number | Pattern
    ? O extends readonly (infer E)[]
      ? E
      : unknown
    : TSegment extends CursorMarker
    ? O extends string
      ? string
      : unknown
    : TSegment extends string
    ? TSegment extends keyof O
      ? O[TSegment]
      : unknown
    : unknown
  : unknown

/**
 * Whether stepping `TObj` via `TSegment` can resolve to "absent":
 * - an array index (`number`) or pattern (`Pattern`) - out of bounds / no
 *   match, mirroring `noUncheckedIndexedAccess`
 * - an optional / `undefined`-valued object key
 *
 * A literal key into a required field is never absent, so root and
 * key-only paths stay free of a spurious `| undefined`.
 */
type HopCanBeAbsent<TObj, TSegment> = NonNullable<TObj> extends infer O
  ? TSegment extends number | Pattern
    ? true
    : TSegment extends string
    ? TSegment extends keyof O
      ? undefined extends O[TSegment]
        ? true
        : false
      : false
    : false
  : false

/** Leaf value type, traversing with intermediate nullability stripped. */
type ExactPathValue<
  TDoc,
  TPath extends readonly any[]
> = TPath extends readonly []
  ? TDoc
  : TPath extends readonly [infer First, ...infer Rest]
  ? ExactPathValue<StepValue<TDoc, First>, Rest>
  : unknown

/**
 * Whether the resolved value can be `undefined`: either the base is itself
 * nullable (e.g. chaining `.sub()` off an index/pattern handle) or some hop
 * along the path can be absent.
 */
type PathIsNullable<
  TDoc,
  TPath extends readonly any[]
> = undefined extends TDoc
  ? true
  : TPath extends readonly [infer First, ...infer Rest]
  ? HopCanBeAbsent<TDoc, First> extends true
    ? true
    : PathIsNullable<StepValue<TDoc, First>, Rest>
  : false

/**
 * Recursively infer the value type at `TPath`. `undefined` is introduced
 * only where the value genuinely might not be there (array index, pattern
 * match, or optional key); the root and required-key paths are
 * `undefined`-free.
 */
export type PathValue<TDoc, TPath extends readonly any[]> = PathIsNullable<
  TDoc,
  TPath
> extends true
  ? ExactPathValue<TDoc, TPath> | undefined
  : ExactPathValue<TDoc, TPath>

export type InferSubType<TDoc, TPath extends readonly any[]> = PathValue<
  TDoc,
  TPath
>

// Utility Types for string and path parsing

/** Split a string by a delimiter into a tuple */
type Split<
  S extends string,
  D extends string = "/"
> = S extends `${infer Head}${D}${infer Tail}`
  ? [Head, ...Split<Tail, D>]
  : S extends ""
  ? []
  : [S]

/** Check if a string represents an index (@0, @42) */
type IsIndex<S extends string> = S extends `@${infer N}`
  ? N extends `${number}`
    ? true
    : false
  : false

/** Check if a string represents a cursor range ([cursor] or [start-end]) */
type IsCursorRange<S extends string> = S extends `[${string}]` ? true : false

/** Marker type for cursor range segments parsed from strings */
type CursorRangeMarker = { __cursorRange: true }

/**
 * Parse a string segment into its semantic type for inference:
 * - "@0", "@123" → number (array index)
 * - "[cursor]", "[start-end]" → CursorRangeMarker (text range → string value)
 * - "key", "123" → literal string (object key - numbers are keys now!)
 */
type ParseSegment<S extends string> = IsCursorRange<S> extends true
  ? CursorRangeMarker
  : IsIndex<S> extends true
  ? number
  : S

/** Convert a path string into a tuple of parsed segment types */
export type SegmentsFromString<P extends string> =
  Split<P> extends infer Segments
    ? Segments extends readonly string[]
      ? { [K in keyof Segments]: ParseSegment<Segments[K] & string> }
      : never
    : never

/** Step one parsed string segment into `TObj` (parent nullability stripped). */
type StepValueFromString<TObj, TSegment> = NonNullable<TObj> extends infer O
  ? TSegment extends CursorRangeMarker
    ? O extends string
      ? string
      : unknown
    : TSegment extends number
    ? O extends readonly (infer E)[]
      ? E
      : unknown
    : TSegment extends string
    ? TSegment extends keyof O
      ? O[TSegment]
      : unknown
    : unknown
  : unknown

/**
 * Whether a parsed string hop can be absent. String paths can only carry
 * keys (`key`), array indices (`@n` → `number`) and cursor ranges, so the
 * absent-able hops are array indices and optional keys.
 */
type HopCanBeAbsentFromString<
  TObj,
  TSegment
> = NonNullable<TObj> extends infer O
  ? TSegment extends number
    ? true
    : TSegment extends CursorRangeMarker
    ? false
    : TSegment extends string
    ? TSegment extends keyof O
      ? undefined extends O[TSegment]
        ? true
        : false
      : false
    : false
  : false

/** Leaf value type for a parsed string path, intermediate nullability stripped. */
type ExactPathValueFromString<
  TDoc,
  TPath extends readonly any[]
> = TPath extends readonly []
  ? TDoc
  : TPath extends readonly [infer First, ...infer Rest]
  ? ExactPathValueFromString<StepValueFromString<TDoc, First>, Rest>
  : unknown

/** Whether a parsed string path can resolve to `undefined`. */
type PathIsNullableFromString<
  TDoc,
  TPath extends readonly any[]
> = undefined extends TDoc
  ? true
  : TPath extends readonly [infer First, ...infer Rest]
  ? HopCanBeAbsentFromString<TDoc, First> extends true
    ? true
    : PathIsNullableFromString<StepValueFromString<TDoc, First>, Rest>
  : false

/** Recursively traverse document type using parsed path segments */
type PathValueFromString<
  TDoc,
  TPath extends readonly any[]
> = PathIsNullableFromString<TDoc, TPath> extends true
  ? ExactPathValueFromString<TDoc, TPath> | undefined
  : ExactPathValueFromString<TDoc, TPath>

/** Infer the sub-handle value type from a document type and path string */
export type InferSubTypeFromString<
  TDoc,
  P extends string
> = PathValueFromString<TDoc, SegmentsFromString<P>>