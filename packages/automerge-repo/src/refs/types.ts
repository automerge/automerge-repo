import type { Cursor } from "@automerge/automerge/slim"
import type { DocHandle } from "../DocHandle.js"

/**
 * Symbol used as discriminator for segments to avoid collision with user data.
 * Users might have objects with a 'kind' property in id patterns.
 */
export const KIND = "AUTOMERGE_REF_KIND"

/**
 * Symbol to mark a cursor request for stabilization during ref creation.
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

/** Path segments that have prop (non-terminal) */
export type PathSegment =
  | { [KIND]: "key"; key: string; prop?: string } // Object property access by key name
  | { [KIND]: "index"; index: number; prop?: number } // Array/list access by numeric index (position-based)
  | {
      [KIND]: "match"
      match: Pattern
      prop?: number
    }

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
 * Passed to change callbacks when the ref points to a string value.
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
 * Return a new value to update primitive values, or void to skip the update.
 * For strings, receives a MutableText object with splice/updateText methods.
 *
 * Note: Objects and arrays should be mutated in place (not returned).
 * Returning non-primitives will trigger a runtime warning.
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type ChangeFn<T> = (val: T extends string ? MutableText : T) => T | void

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

export type InferRefType<TDoc, TPath extends readonly any[]> = PathValue<
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

/** Infer the ref value type from a document type and path string */
export type InferRefTypeFromString<
  TDoc,
  P extends string
> = PathValueFromString<TDoc, SegmentsFromString<P>>

/**
 * Branded type for ref URLs.
 * A string in the format: `automerge:documentId/path#heads`
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type RefUrl = string & { readonly __brand: "RefUrl" }

/**
 * A reference to a location in an Automerge document.
 *
 * This type is a deprecated alias for `DocHandle<TValue>`. The two concepts have been
 * unified: a sub-document `DocHandle` carries a `path` and (optionally) a `range` and
 * supports the same surface as a root handle, so existing `Ref`-typed code continues
 * to work unchanged.
 *
 * @deprecated Use `DocHandle<TValue>` directly.
 * @experimental This API is experimental and may change in future versions.
 */
export type Ref<TValue = unknown> = DocHandle<TValue>
