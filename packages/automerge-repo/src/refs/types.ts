import type { Cursor, Heads, Doc } from "@automerge/automerge/slim"
import type { DocHandle, DocHandleChangePayload } from "../DocHandle.js"

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
export type Pattern = Record<string, string | number | boolean | null>;

/**
 * Marker type for cursor-based range that will be stabilized.
 * Created via cursor() function and only valid as the last path argument.
 */
export interface CursorMarker {
  [CURSOR_MARKER]: true;
  start: number;
  end: number;
}

/** Path segments that have prop (non-terminal) */
export type PathSegment =
  | { [KIND]: "key"; key: string; prop?: string } // Object property access by key name
  | { [KIND]: "index"; index: number; prop?: number } // Array/list access by numeric index (position-based)
  | {
      [KIND]: "match";
      match: Pattern;
      prop?: number;
    };

/** Cursor range segment (always terminal) */
export type CursorRange = { [KIND]: "cursors"; start: Cursor; end: Cursor };

/** All segment types */
export type Segment = PathSegment | CursorRange;

/** A codec handles parsing and serialization for one segment type. */
export interface SegmentCodec<K extends Segment[typeof KIND]> {
  kind: K;
  /** Does this string match this codec's format? */
  match(s: string): boolean;
  /** Parse string to segment (assumes match() returned true) */
  parse(s: string): Extract<Segment, { [KIND]: K }>;
  serialize(seg: Extract<Segment, { [KIND]: K }>): string;
}

/**
 * Input types that users can provide to create refs.
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type PathInput = string | number | Pattern | CursorMarker;

/** Internal: PathInput extended with Segment for URL parsing and internal use */
export type AnyPathInput = PathInput | Segment;

export interface RefOptions {
  heads?: Heads;
}

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
  splice(index: number, deleteCount: number, insert?: string): void;
  /** Replace entire text content - uses Automerge.updateText for CRDT-safe mutation */
  updateText(newValue: string): void;
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
export type ChangeFn<T> = (val: T extends string ? MutableText : T) => T | void;

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
      : unknown;

/** Recursively infer type by traversing path through document */
export type PathValue<TDoc, TPath extends readonly any[]> = TPath extends []
  ? TDoc
  : TPath extends readonly [infer First, ...infer Rest]
    ? GetSegmentValue<TDoc, First> extends infer Next
      ? Next extends never
        ? unknown
        : PathValue<Next, Rest>
      : unknown
    : unknown;

export type InferRefType<TDoc, TPath extends readonly any[]> = PathValue<
  TDoc,
  TPath
>;

// Utility Types for string and path parsing

/** Split a string by a delimiter into a tuple */
type Split<
  S extends string,
  D extends string = "/",
> = S extends `${infer Head}${D}${infer Tail}`
  ? [Head, ...Split<Tail, D>]
  : S extends ""
    ? []
    : [S];

/** Check if a string represents an index (@0, @42) */
type IsIndex<S extends string> = S extends `@${infer N}`
  ? N extends `${number}`
    ? true
    : false
  : false;

/** Check if a string represents a cursor range ([cursor] or [start-end]) */
type IsCursorRange<S extends string> = S extends `[${string}]` ? true : false;

/** Marker type for cursor range segments parsed from strings */
type CursorRangeMarker = { __cursorRange: true };

/**
 * Parse a string segment into its semantic type for inference:
 * - "@0", "@123" → number (array index)
 * - "[cursor]", "[start-end]" → CursorRangeMarker (text range → string value)
 * - "key", "123" → literal string (object key - numbers are keys now!)
 */
type ParseSegment<S extends string> =
  IsCursorRange<S> extends true
    ? CursorRangeMarker
    : IsIndex<S> extends true
      ? number
      : S;

/** Convert a path string into a tuple of parsed segment types */
export type SegmentsFromString<P extends string> =
  Split<P> extends infer Segments
    ? Segments extends readonly string[]
      ? { [K in keyof Segments]: ParseSegment<Segments[K] & string> }
      : never
    : never;

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
      : unknown;

/** Recursively traverse document type using parsed path segments */
type PathValueFromString<
  TDoc,
  TPath extends readonly any[],
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
    : unknown;

/** Infer the ref value type from a document type and path string */
export type InferRefTypeFromString<
  TDoc,
  P extends string,
> = PathValueFromString<TDoc, SegmentsFromString<P>>;

/**
 * Branded type for ref URLs.
 * A string in the format: `automerge:documentId/path#heads`
 *
 * @experimental This API is experimental and may change in future versions.
 */
export type RefUrl = string & { readonly __brand: "RefUrl" };

/**
 * A reference to a location in an Automerge document.
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @typeParam TValue - The type of value this ref points to (defaults to unknown)
 *
 * @example
 * ```ts
 * // Create a ref via DocHandle
 * const titleRef = handle.ref('todos', 0, 'title');
 * titleRef.value();           // string | undefined
 * titleRef.change(s => s.toUpperCase());
 * titleRef.onChange(() => console.log('changed!'));
 *
 * // Use in function signatures
 * function doubleIt(ref: Ref<number>) {
 *   ref.change(n => n * 2);
 * }
 * ```
 */
export interface Ref<TValue = unknown> {
  /** The document handle this ref belongs to */
  readonly docHandle: DocHandle<any>;

  /** The resolved path segments */
  readonly path: PathSegment[];

  /** The cursor range, if this ref points to a text range */
  readonly range?: CursorRange;

  /** Options including heads for time-travel */
  readonly options: RefOptions;

  /** The heads this ref is pinned to, if any */
  readonly heads: Heads | undefined;

  /** The numeric positions of the range, if this is a range ref */
  readonly rangePositions: [number, number] | undefined;

  /** The URL representation of this ref */
  readonly url: RefUrl;

  /**
   * Create a new ref viewing the document at specific heads (time-travel).
   * Returns a new Ref instance with the same path but different heads.
   */
  viewAt(heads: Heads | undefined): Ref<TValue>;

  /** Get the current value, or undefined if path can't be resolved */
  value(): TValue | undefined;

  /** Get the document at the ref's heads (or current if no heads pinned) */
  doc(): Doc<any>;

  /**
   * Update the value.
   *
   * For primitives, you can pass either:
   * - A function that receives the current value and returns the new value
   * - A direct value (shorthand for primitives)
   */
  change(fnOrValue: ChangeFn<TValue> | TValue): void;

  /**
   * Remove the value this ref points to from its parent container.
   *
   * - For object properties: deletes the key from the object
   * - For array elements: removes the item from the array
   * - For text ranges: deletes the text within the range
   */
  remove(): void;

  /**
   * Subscribe to changes that affect this ref's value.
   * Returns an unsubscribe function.
   */
  onChange(
    callback: (
      value: TValue | undefined,
      payload: DocHandleChangePayload<any>
    ) => void
  ): () => void;

  /** Check if this ref is equal to another ref (same document, path, and heads). */
  equals(other: Ref<unknown>): boolean;

  /**
   * Check if this ref contains another ref (other is a descendant of this).
   */
  contains(other: Ref<unknown>): boolean;

  /**
   * Check if this ref is a child of another ref.
   */
  isChildOf(parent: Ref<unknown>): boolean;

  /**
   * Check if this ref overlaps with another ref (for text/range refs).
   */
  overlaps(other: Ref<unknown>): boolean;

  /**
   * Check if this ref is equivalent to another ref.
   * Two refs are equivalent if they point to the same value in the document,
   * even if they use different addressing schemes (e.g., index vs pattern).
   *
   * Short-circuits for fast rejection when refs are obviously different.
   *
   * @example
   * ```ts
   * const byIndex = ref(handle, 'todos', 0);
   * const byId = ref(handle, 'todos', { id: 'abc' });
   * // If todos[0].id === 'abc', these are equivalent
   * byIndex.isEquivalent(byId); // true
   * ```
   */
  isEquivalent(other: Ref<unknown>): boolean;

  /** Returns the ref URL */
  valueOf(): string;

  /** Returns the ref URL */
  toString(): string;
}
