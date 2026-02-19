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
  readonly docHandle: DocHandle<any>

  /** The resolved path segments */
  readonly path: PathSegment[]

  /** The cursor range, if this ref points to a text range */
  readonly range?: CursorRange

  /** The numeric positions of the range, if this is a range ref */
  readonly rangePositions: [number, number] | undefined

  /** The URL representation of this ref */
  readonly url: RefUrl

  /**
   * Create a new ref viewing the document at specific heads (time-travel).
   * Returns a new Ref instance on a read-only view handle at the specified heads.
   *
   * @param heads - The document heads to view (hex-encoded, from Automerge.getHeads)
   * @returns A new Ref instance pointing to the same path but at the specified heads
   *
   * @example
   * ```ts
   * // Get current heads before making changes
   * const heads = Automerge.getHeads(handle.doc());
   *
   * // Make changes
   * handle.change(d => { d.value = 'new' });
   *
   * // View the old state
   * const pastRef = handle.ref('value').viewAt(heads);
   * pastRef.value(); // returns old value
   * ```
   */
  viewAt(heads: Heads): Ref<TValue>

  /**
   * Get the current value at this ref's path.
   *
   * @returns The value, or undefined if the path can't be resolved
   *
   * @example
   * ```ts
   * const titleRef = handle.ref('todos', 0, 'title');
   * titleRef.value(); // "Buy milk" or undefined
   * ```
   */
  value(): TValue | undefined

  /**
   * Get the underlying Automerge document.
   * For refs on read-only view handles, returns the document at those heads.
   */
  doc(): Doc<any>

  /**
   * Update the value at this ref's path.
   *
   * For primitives, you can pass either:
   * - A function that receives the current value and returns the new value
   * - A direct value (shorthand for primitives)
   *
   * For objects and arrays, mutate them in place within the function
   * (same semantics as Automerge). Returning new object/array instances
   * will trigger a warning as it loses granular change tracking.
   *
   * @throws Error if the ref is on a read-only handle (time-traveled view)
   * @throws Error if the path cannot be resolved
   *
   * @example
   * ```ts
   * // Function form (works for all types)
   * counterRef.change(n => n + 1);
   * themeRef.change(t => t === 'dark' ? 'light' : 'dark');
   *
   * // Shorthand for primitives
   * themeRef.change('dark');
   * counterRef.change(42);
   *
   * // Objects/arrays: mutate in place
   * todoRef.change(todo => { todo.done = true; });
   * ```
   */
  change(fnOrValue: ChangeFn<TValue> | TValue): void

  /**
   * Remove the value this ref points to from its parent container.
   *
   * - For object properties: deletes the key from the object
   * - For array elements: removes the item from the array (splice)
   * - For text ranges: deletes the text within the range
   *
   * @throws Error if the ref points to the root document
   * @throws Error if the ref is on a read-only handle
   * @throws Error if the path cannot be resolved
   *
   * @example
   * ```ts
   * // Remove a property from an object
   * const nameRef = handle.ref('user', 'name');
   * nameRef.remove(); // deletes handle.doc().user.name
   *
   * // Remove an item from an array
   * const todoRef = handle.ref('todos', 0);
   * todoRef.remove(); // removes first todo from array
   *
   * // Remove text within a range
   * const rangeRef = handle.ref('text', cursor(0, 5));
   * rangeRef.remove(); // deletes first 5 characters
   * ```
   */
  remove(): void

  /**
   * Subscribe to changes that affect this ref's value.
   *
   * The callback is invoked whenever a change affects the value at this
   * ref's path. It receives the new value and the change payload.
   *
   * @returns An unsubscribe function to stop listening
   *
   * @example
   * ```ts
   * const unsubscribe = titleRef.onChange((value, payload) => {
   *   console.log('Title changed to:', value);
   * });
   *
   * // Later, stop listening
   * unsubscribe();
   * ```
   */
  onChange(
    callback: (
      value: TValue | undefined,
      payload: DocHandleChangePayload<any>
    ) => void
  ): () => void

  /**
   * Check if this ref is equal to another ref.
   * Two refs are equal if they have the same URL (document, path, and heads).
   */
  equals(other: Ref<unknown>): boolean

  /**
   * Check if this ref contains another ref (other is a descendant of this).
   *
   * @example
   * ```ts
   * const todoRef = handle.ref('todos', 0);
   * const titleRef = handle.ref('todos', 0, 'title');
   * todoRef.contains(titleRef); // true
   * titleRef.contains(todoRef); // false
   * ```
   */
  contains(other: Ref<unknown>): boolean

  /**
   * Check if this ref is a child of another ref.
   *
   * For arrays: only direct array elements are considered children
   * (path must be exactly one segment longer).
   *
   * For text: sub-ranges within the text are considered children
   * (same path with a range, or one segment deeper).
   *
   * @example
   * ```ts
   * // Array children
   * const arrayRef = handle.ref('items');
   * const itemRef = handle.ref('items', 0);
   * itemRef.isChildOf(arrayRef); // true
   *
   * // Text range children
   * const textRef = handle.ref('content');
   * const rangeRef = handle.ref('content', cursor(0, 10));
   * rangeRef.isChildOf(textRef); // true
   * ```
   */
  isChildOf(parent: Ref<unknown>): boolean

  /**
   * Check if this ref overlaps with another ref (for text/range refs).
   * Two refs overlap if they refer to the same parent location and their
   * cursor ranges overlap.
   *
   * @example
   * ```ts
   * const range1 = handle.ref('content', cursor(0, 10));
   * const range2 = handle.ref('content', cursor(5, 15));
   * range1.overlaps(range2); // true (overlap at positions 5-10)
   * ```
   */
  overlaps(other: Ref<unknown>): boolean

  /**
   * Check if this ref is equivalent to another ref.
   * Two refs are equivalent if they point to the same value in the document,
   * even if they use different addressing schemes (e.g., index vs pattern).
   *
   * This is useful when you have refs created with different path types
   * (e.g., by array index vs by object pattern match) and need to check
   * if they resolve to the same location.
   *
   * Short-circuits for fast rejection when refs are obviously different.
   *
   * @example
   * ```ts
   * const byIndex = handle.ref('todos', 0);
   * const byId = handle.ref('todos', { id: 'abc' });
   * // If todos[0].id === 'abc', these are equivalent
   * byIndex.isEquivalent(byId); // true
   * ```
   */
  isEquivalent(other: Ref<unknown>): boolean

  /** Returns the ref URL */
  valueOf(): string

  /** Returns the ref URL */
  toString(): string
}
