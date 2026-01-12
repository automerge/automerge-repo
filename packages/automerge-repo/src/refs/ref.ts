import * as Automerge from "@automerge/automerge";
import type { Doc, Prop } from "@automerge/automerge";
import type {
  DocHandle,
  DocHandleChangePayload,
} from "@automerge/automerge-repo";
import type {
  Segment,
  PathSegment,
  CursorRange,
  AnyPathInput,
  Pattern,
  RefOptions,
  InferRefType,
  ChangeFn,
  RefUrl,
} from "./types.js";
import { KIND } from "./types.js";
import { isSegment, isPattern } from "./guards.js";
import { matchesPattern } from "./utils.js";
import { isCursorMarker } from "./guards.js";
import type { CursorMarker } from "./types.js";
import { stringifyRefUrl } from "./parser.js";
import { MutableText } from "./mutable-text.js";

/**
 * FinalizationRegistry for automatic cleanup of Ref instances.
 * This ensures subscriptions are cleaned up when Refs are garbage collected,
 * even if dispose() is never called.
 */
const refCleanupRegistry = new FinalizationRegistry<() => void>((cleanup) =>
  cleanup()
);

/**
 * A reference to a location in an Automerge document.
 *
 * Refs are stable by default - they track objects by ID, not position.
 *
 * Cleanup: Refs automatically clean up their subscriptions when garbage collected.
 *
 * @example
 * ```ts
 * const titleRef = ref(handle, 'todos', 0, 'title');
 * titleRef.value();           // string | undefined
 * titleRef.change(s => s.toUpperCase());
 * titleRef.onChange(() => console.log('changed!'));
 * ```
 */
export class Ref<
  TDoc = any,
  TPath extends readonly AnyPathInput[] = AnyPathInput[],
> {
  readonly docHandle: DocHandle<TDoc>;
  readonly path: PathSegment[];
  readonly range?: CursorRange;
  readonly options: RefOptions;

  #onChangeCallbacks = new Set<
    (payload: DocHandleChangePayload<any>) => void
  >();
  #updateHandler: () => void;

  constructor(
    docHandle: DocHandle<TDoc>,
    segments: readonly [...TPath],
    options: RefOptions = {}
  ) {
    this.docHandle = docHandle;
    this.options = options;

    const doc = docHandle.doc();
    const { path, range } = this.#normalizePath(
      doc,
      segments as unknown as AnyPathInput[]
    );
    this.path = path;
    this.range = range;

    this.#updateHandler = () => {
      const currentDoc = this.docHandle.doc();
      this.#updateProps(currentDoc);
    };
    this.docHandle.on("change", this.#updateHandler);

    // Register for automatic cleanup when this Ref is garbage collected
    refCleanupRegistry.register(this, () => this.#cleanup(), this);
  }

  #cleanup(): void {
    this.docHandle.off("change", this.#updateHandler);
    for (const callback of this.#onChangeCallbacks) {
      this.docHandle.off("change", callback);
    }
    this.#onChangeCallbacks.clear();
  }

  get heads(): string[] | undefined {
    return this.options.heads;
  }

  get rangePositions(): [number, number] | undefined {
    if (!this.range) return undefined;
    const propPath = this.#getPropPath();
    if (!propPath) return undefined;
    const doc = this.doc();
    return this.#getRangePositions(doc, propPath, this.range);
  }

  /**
   * Create a new ref viewing the document at specific heads (time-travel).
   * Returns a new Ref instance with the same path but different heads.
   */
  viewAt(heads: string[] | undefined): Ref<TDoc, TPath> {
    return new Ref(this.docHandle, this.path as any, {
      ...this.options,
      heads,
    });
  }

  /** Get the current value, or undefined if path can't be resolved */
  value(): InferRefType<TDoc, TPath> | undefined {
    const doc = this.doc();
    const propPath = this.#getPropPath();
    if (!propPath) return undefined;

    const value = this.#getValueAt(doc, propPath);

    return (
      this.range ? this.#extractRange(doc, propPath, value, this.range) : value
    ) as InferRefType<TDoc, TPath> | undefined;
  }

  doc(): Doc<TDoc> {
    const doc = this.docHandle.doc();
    return this.options.heads ? Automerge.view(doc, this.options.heads) : doc;
  }

  /**
   * Update the value.
   *
   * For primitives, you can pass either:
   * - A function that receives the current value and returns the new value
   * - A direct value (shorthand for primitives)
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
   * // Objects/arrays: mutate in place (same semantics as automerge-repo)
   * todoRef.change(todo => { todo.done = true; });
   * ```
   */
  change(
    fnOrValue: ChangeFn<InferRefType<TDoc, TPath>> | InferRefType<TDoc, TPath>
  ): void {
    if (this.options.heads) {
      throw new Error("Cannot change a Ref pinned to specific heads");
    }

    // Convert direct value to function form
    const fn: ChangeFn<InferRefType<TDoc, TPath>> =
      typeof fnOrValue === "function"
        ? (fnOrValue as ChangeFn<InferRefType<TDoc, TPath>>)
        : () => fnOrValue as InferRefType<TDoc, TPath>;

    this.docHandle.change((doc: Doc<TDoc>) => {
      if (this.path.length === 0 && !this.range) {
        fn(doc as any);
        return;
      }

      const propPath = this.#getPropPath();
      if (!propPath) throw new Error("Cannot resolve path");

      let current: any;
      if (this.range) {
        const parent = this.#getValueAt(doc, propPath);
        if (typeof parent !== "string") {
          throw new Error("Range refs can only be used on string values");
        }
        current = this.#extractRange(doc, propPath, parent, this.range);
      } else {
        current = this.#getValueAt(doc, propPath);
      }

      // If current is a string, wrap it in MutableText
      const valueToPass =
        typeof current === "string"
          ? MutableText(doc, propPath, current)
          : current;

      const newValue = fn(valueToPass);
      if (newValue === undefined) return;

      // Warn if non-primitive value is returned (should mutate instead)
      if (
        !(
          newValue === null ||
          typeof newValue === "string" ||
          typeof newValue === "number" ||
          typeof newValue === "boolean" ||
          typeof newValue === "bigint"
        )
      ) {
        console.warn(
          "Ref.change() returned a non-primitive value. For objects and arrays, " +
            "you should mutate them in place rather than returning a new instance. " +
            "Returning new instances loses granular change tracking."
        );
      }

      if (this.range) {
        this.#spliceRange(doc, propPath, this.range, newValue as string);
      } else {
        this.#setValueAt(doc, propPath, newValue);
      }
    });
  }

  /**
   * Remove the value this ref points to from its parent container.
   *
   * - For object properties: deletes the key from the object
   * - For array elements: removes the item from the array
   * - For text ranges: deletes the text within the range
   *
   * @throws Error if the ref points to the root document
   * @throws Error if the ref is pinned to specific heads
   * @throws Error if the path cannot be resolved
   *
   * @example
   * ```ts
   * // Remove a property from an object
   * const nameRef = ref(handle, 'user', 'name');
   * nameRef.remove(); // deletes handle.doc().user.name
   *
   * // Remove an item from an array
   * const todoRef = ref(handle, 'todos', 0);
   * todoRef.remove(); // removes first todo from array
   *
   * // Remove text within a range
   * const rangeRef = ref(handle, 'text', cursor(0, 5));
   * rangeRef.remove(); // deletes first 5 characters
   * ```
   */
  remove(): void {
    if (this.options.heads) {
      throw new Error("Cannot remove from a Ref pinned to specific heads");
    }

    if (this.path.length === 0 && !this.range) {
      throw new Error("Cannot remove the root document");
    }

    this.docHandle.change((doc: Doc<TDoc>) => {
      const propPath = this.#getPropPath();
      if (!propPath || propPath.length === 0) {
        throw new Error("Cannot resolve path for removal");
      }

      // Handle range refs - delete the text within the range
      if (this.range) {
        this.#spliceRange(doc, propPath, this.range, "");
        return;
      }

      const parentPath = propPath.slice(0, -1);
      const key = propPath[propPath.length - 1];
      const parent =
        parentPath.length === 0 ? doc : this.#getValueAt(doc, parentPath);

      if (parent == null) {
        throw new Error("Cannot remove: parent is null or undefined");
      }

      if (Array.isArray(parent)) {
        if (typeof key !== "number") {
          throw new Error("Cannot remove from array: key is not a number");
        }
        parent.splice(key, 1);
      } else {
        delete parent[key];
      }
    });
  }

  /**
   * Subscribe to changes that affect this ref's value.
   *
   * Returns an unsubscribe function you can call
   */
  onChange(
    callback: (
      value: InferRefType<TDoc, TPath> | undefined,
      payload: DocHandleChangePayload<any>
    ) => void
  ): () => void {
    const wrappedCallback = (payload: DocHandleChangePayload<any>) => {
      if (this.#patchAffectsRef(payload.patches)) {
        const value = this.value();
        callback(value, payload);
      }
    };

    this.docHandle.on("change", wrappedCallback);

    // Track this callback so it can be cleaned up in dispose()
    this.#onChangeCallbacks.add(wrappedCallback);

    const unsubscribe = () => {
      this.docHandle.off("change", wrappedCallback);
      this.#onChangeCallbacks.delete(wrappedCallback);
    };

    return unsubscribe;
  }

  get url(): RefUrl {
    const allSegments: Segment[] = this.range
      ? [...this.path, this.range]
      : this.path;

    return stringifyRefUrl(
      this.docHandle.documentId,
      allSegments,
      this.options.heads
    );
  }

  /**
   * Check if this ref is equal to another ref (same document, path, and heads).
   */
  equals(other: Ref<any>): boolean {
    return this.url === other.url;
  }

  /**
   * Check if this ref contains another ref (other is a descendant of this).
   *
   * @example
   * ```ts
   * const todoRef = ref(handle, 'todos', 0);
   * const titleRef = ref(handle, 'todos', 0, 'title');
   * todoRef.contains(titleRef); // true
   * titleRef.contains(todoRef); // false
   * ```
   */
  contains(other: Ref<any>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== other.docHandle.documentId) {
      return false;
    }

    // Must have same or undefined heads
    const thisHeads = this.heads?.join();
    const otherHeads = other.heads?.join();
    if (thisHeads !== otherHeads) {
      return false;
    }

    // This path must be a prefix of other's path
    if (this.path.length >= other.path.length) {
      return false;
    }

    // Check if all segments match
    for (let i = 0; i < this.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], other.path[i])) {
        return false;
      }
    }

    return true;
  }

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
   * const arrayRef = ref(handle, 'items');
   * const itemRef = ref(handle, 'items', 0);
   * itemRef.isChildOf(arrayRef); // true
   *
   * // Text range children
   * const textRef = ref(handle, 'content');
   * const rangeRef = ref(handle, 'content', [0, 10]);
   * rangeRef.isChildOf(textRef); // true
   * ```
   */
  isChildOf(parent: Ref<any>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== parent.docHandle.documentId) {
      return false;
    }

    // Must have same heads
    const thisHeads = this.heads?.join(",");
    const parentHeads = parent.heads?.join(",");
    if (thisHeads !== parentHeads) {
      return false;
    }

    // Check if paths match up to parent's length
    if (this.path.length < parent.path.length) {
      return false;
    }

    // All of parent's path segments must match
    for (let i = 0; i < parent.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], parent.path[i])) {
        return false;
      }
    }

    // Case 1: Same path length - only valid if this has a range and parent doesn't
    // (this is a range child of text)
    if (this.path.length === parent.path.length) {
      return this.range !== undefined && parent.range === undefined;
    }

    // Case 2: Path is exactly one segment longer (direct child)
    if (this.path.length === parent.path.length + 1) {
      return true;
    }

    // Case 3: Path is more than one segment longer (not a direct child)
    return false;
  }

  /**
   * Check if this ref overlaps with another ref (for text/range refs).
   * Two refs overlap if they refer to the same parent location and their ranges overlap.
   *
   * @example
   * ```ts
   * const range1 = ref(handle, 'content', [0, 10]);
   * const range2 = ref(handle, 'content', [5, 15]);
   * range1.overlaps(range2); // true
   * ```
   */
  overlaps(other: Ref<any>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== other.docHandle.documentId) {
      return false;
    }

    // Must have same heads
    const thisHeads = this.heads?.join();
    const otherHeads = other.heads?.join();
    if (thisHeads !== otherHeads) {
      return false;
    }

    // Both must have ranges
    if (!this.range || !other.range) {
      return false;
    }

    // Paths must be identical (same parent location)
    if (this.path.length !== other.path.length) {
      return false;
    }

    for (let i = 0; i < this.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], other.path[i])) {
        return false;
      }
    }

    // Check if ranges overlap
    // Get the numeric positions for both ranges
    const doc = this.doc();
    const propPath = this.#getPropPath();
    if (!propPath) return false;

    const thisPositions = this.#getRangePositions(doc, propPath, this.range);
    const otherPositions = this.#getRangePositions(doc, propPath, other.range);

    if (!thisPositions || !otherPositions) return false;

    const [thisStart, thisEnd] = thisPositions;
    const [otherStart, otherEnd] = otherPositions;

    // Ranges overlap if: thisStart < otherEnd && otherStart < thisEnd
    return thisStart < otherEnd && otherStart < thisEnd;
  }

  valueOf(): string {
    return this.url;
  }

  toString(): string {
    return this.url;
  }

  /**
   * Normalize path inputs and extract stable IDs where possible.
   */
  #normalizePath(
    doc: Doc<TDoc>,
    inputs: AnyPathInput[]
  ): { path: PathSegment[]; range?: CursorRange } {
    const pathSegments: PathSegment[] = [];
    const propPath: Automerge.Prop[] = [];
    let current: any = doc;
    let rangeSegment: CursorRange | undefined;

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];

      // Handle cursor() marker - creates cursor-based range
      if (isCursorMarker(input)) {
        // cursor() must be the last segment
        if (i < inputs.length - 1) {
          throw new Error(
            "cursor() must be the last segment in a ref path. " +
              "Segments after cursor() are not allowed."
          );
        }
        rangeSegment = this.#createCursorRange(doc, propPath, current, input);
        break;
      }

      const segment = isSegment(input)
        ? this.#ensureSegmentResolved(current, input)
        : this.#normalizeInput(current, input);

      if (segment[KIND] === "cursors") {
        // Cursor range from URL parsing - must also be last
        if (i < inputs.length - 1) {
          throw new Error(
            "Cursor range must be the last segment in a ref path. " +
              "Segments after cursor range are not allowed."
          );
        }
        rangeSegment = segment;
        break;
      }

      pathSegments.push(segment);

      if (
        segment.prop !== undefined &&
        current !== undefined &&
        current !== null
      ) {
        propPath.push(segment.prop);
        current = current[segment.prop];
      }
    }

    return { path: pathSegments, range: rangeSegment };
  }

  /** Ensure a segment has its prop set */
  #ensureSegmentResolved(container: any, segment: Segment): Segment {
    const prop = this.#resolveSegmentProp(container, segment);
    return { ...segment, prop } as Segment;
  }

  /**
   * Resolve a path segment to its Automerge prop.
   * Returns undefined if the segment cannot be resolved.
   */
  #resolveSegmentProp(
    container: any,
    segment: Segment
  ): string | number | undefined {
    if (container === undefined || container === null) return undefined;

    switch (segment[KIND]) {
      case "key":
        return segment.key;

      case "index":
        return segment.index;

      case "match": {
        if (!Array.isArray(container)) return undefined;
        const matchIndex = container.findIndex((item) =>
          matchesPattern(item, segment.match)
        );
        return matchIndex !== -1 ? matchIndex : undefined;
      }
      case "cursors":
        return undefined;

      default:
        segment satisfies never;
        return undefined;
    }
  }

  /** Update resolved props for all path segments based on current document state */
  #updateProps(doc: Doc<TDoc>): void {
    let current = doc;

    for (const segment of this.path) {
      const prop = this.#resolveSegmentProp(current, segment);
      // Internal mutation: Update cached prop for efficient path resolution.
      // Safe because segments are owned by this Ref instance.
      segment.prop = prop;

      if (prop !== undefined && current !== undefined && current !== null) {
        current = (current as any)[prop];
      } else {
        break;
      }
    }
  }

  /**
   * Check if two PathSegments are equal.
   * Used by `contains` and `overlaps` methods.
   */
  #segmentsEqual(a: PathSegment, b: PathSegment): boolean {
    if (a[KIND] !== b[KIND]) {
      return false;
    }

    switch (a[KIND]) {
      case "key":
        return a.key === (b as typeof a).key;
      case "index":
        return a.index === (b as typeof a).index;
      case "match": {
        const aKeys = Object.keys(a.match);
        const bKeys = Object.keys((b as typeof a).match);
        if (aKeys.length !== bKeys.length) return false;
        return aKeys.every(
          (key) => a.match[key] === (b as typeof a).match[key]
        );
      }
      default:
        a satisfies never;
        return false;
    }
  }

  #normalizeInput(container: any, input: string | number | Pattern): Segment {
    if (typeof input === "string") {
      return { [KIND]: "key", key: input, prop: input };
    }

    if (typeof input === "number") {
      return { [KIND]: "index", index: input, prop: input };
    }

    if (isPattern(input)) {
      if (!Array.isArray(container)) {
        return { [KIND]: "match", match: input, prop: undefined };
      }

      const index = container.findIndex((obj) => matchesPattern(obj, input));
      return {
        [KIND]: "match",
        match: input,
        prop: index !== -1 ? index : undefined,
      };
    }

    throw new Error(
      `Unsupported path input type: ${typeof input}. ` +
        `Expected string, number, or plain object.`
    );
  }

  /** Create a cursor-based range from a CursorMarker */
  #createCursorRange(
    doc: Doc<TDoc>,
    propPath: Automerge.Prop[],
    container: any,
    marker: CursorMarker
  ): CursorRange {
    const { start, end } = marker;

    if (typeof container !== "string") {
      throw new Error(
        `cursor() can only be used on string values, got ${typeof container}`
      );
    }

    const startCursor = Automerge.getCursor(doc, propPath, start);
    const endCursor = Automerge.getCursor(doc, propPath, end);

    if (!startCursor || !endCursor) {
      throw new Error(`Failed to create cursors at positions ${start}-${end}.`);
    }

    return { [KIND]: "cursors", start: startCursor, end: endCursor };
  }

  /** Extract cached navigation path from segments */
  #getPropPath(): Prop[] | undefined {
    const props: Prop[] = [];
    for (const segment of this.path) {
      if (segment.prop === undefined) return undefined;
      props.push(segment.prop);
    }
    return props;
  }

  /** Navigate to a value by following a prop path */
  #getValueAt(container: any, propPath: Prop[]): any {
    let current = container;
    for (const prop of propPath) {
      if (current == null) return undefined;
      current = current[prop];
    }
    return current;
  }

  /** Extract substring from a text value using a range */
  #extractRange(
    doc: Doc<TDoc>,
    propPath: Prop[],
    text: string,
    range: CursorRange
  ): string | undefined {
    const positions = this.#getRangePositions(doc, propPath, range);
    if (!positions) return undefined;
    return text.slice(positions[0], positions[1]);
  }
  /** Set a value at a prop path (change-only: mutates the doc proxy) */
  #setValueAt(container: any, propPath: Prop[], value: any): void {
    if (propPath.length === 0) {
      throw new Error(
        "Internal error: #setValueAt called with empty path. " +
          "Root document changes should be handled by the caller."
      );
    }
    const parent = this.#getValueAt(container, propPath.slice(0, -1));
    if (parent == null) {
      throw new Error("Cannot set value: parent is null or undefined");
    }
    parent[propPath[propPath.length - 1]] = value;
  }

  /** Replace a substring at a range using Automerge.splice (change-only: mutates the doc proxy) */
  #spliceRange(
    doc: Doc<TDoc>,
    propPath: Prop[],
    range: CursorRange,
    newValue: string
  ): void {
    const positions = this.#getRangePositions(doc, propPath, range);
    if (!positions) {
      throw new Error("Cannot resolve range positions");
    }

    const [start, end] = positions;
    Automerge.splice(doc, propPath, start, end - start, newValue);
  }

  /** Convert cursor positions to numeric [start, end] positions */
  #getRangePositions(
    doc: Doc<TDoc>,
    propPath: Prop[],
    range: CursorRange
  ): [number, number] | undefined {
    const start = Automerge.getCursorPosition(doc, propPath, range.start);
    const end = Automerge.getCursorPosition(doc, propPath, range.end);

    return start !== undefined && end !== undefined ? [start, end] : undefined;
  }

  #patchAffectsRef(patches: Automerge.Patch[]): boolean {
    const refPropPath: Prop[] = [];
    for (const segment of this.path) {
      if (segment.prop === undefined) break;
      refPropPath.push(segment.prop);
    }

    // If we couldn't resolve any part, ref was never valid - don't fire
    if (refPropPath.length === 0) return false;

    return patches.some((patch) => this.#pathsOverlap(patch.path, refPropPath));
  }

  #pathsOverlap(
    patchPath: Automerge.Prop[],
    refPropPath: Automerge.Prop[]
  ): boolean {
    const minLength = Math.min(patchPath.length, refPropPath.length);
    return patchPath
      .slice(0, minLength)
      .every((prop, i) => prop === refPropPath[i]);
  }
}
