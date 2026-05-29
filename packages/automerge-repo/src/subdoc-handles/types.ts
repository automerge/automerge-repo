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
 * Mutable text wrapper that provides Automerge text operations.
 * Passed to change callbacks when the sub-handle points to a string value.
 *
 * Behaves like a string with two additional mutation methods.
 * Uses String (object type) because we proxy all string methods at runtime.
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
  val: T extends string ? MutableText : T
) => T | void

type GetSegmentValue<TObj, TSegment> = TSegment extends string
  ? TSegment extends keyof TObj
    ? TObj[TSegment]
    : unknown
  : TSegment extends number | Pattern
  ? TObj extends readonly (infer E)[]
    ? E
    : unknown
  : TSegment extends CursorMarker
  ? TObj extends string
    ? string
    : unknown
  : unknown

/** Recursively infer type by traversing path through document */
export type PathValue<TDoc, TPath extends readonly any[]> = TPath extends []
  ? TDoc
  : TPath extends readonly [infer First, ...infer Rest]
  ? GetSegmentValue<TDoc, First> extends infer Next
    ? Next extends never
      ? unknown
      : PathValue<Next, Rest>
    : unknown
  : unknown

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

/** Get value type for a parsed string segment */
type GetParsedSegmentValue<TObj, TSegment> = TSegment extends CursorRangeMarker
  ? TObj extends string
    ? string
    : unknown
  : TSegment extends number
  ? TObj extends readonly (infer E)[]
    ? E
    : unknown
  : TSegment extends string
  ? TSegment extends keyof TObj
    ? TObj[TSegment]
    : unknown
  : unknown

/** Recursively traverse document type using parsed path segments */
type PathValueFromString<
  TDoc,
  TPath extends readonly any[]
> = TPath extends readonly []
  ? TDoc
  : TPath extends readonly [infer First, ...infer Rest]
  ? GetParsedSegmentValue<TDoc, First> extends infer Next
    ? Next extends unknown
      ? Rest extends readonly any[]
        ? PathValueFromString<Next, Rest>
        : unknown
      : unknown
    : unknown
  : unknown

/** Infer the sub-handle value type from a document type and path string */
export type InferSubTypeFromString<
  TDoc,
  P extends string
> = PathValueFromString<TDoc, SegmentsFromString<P>>