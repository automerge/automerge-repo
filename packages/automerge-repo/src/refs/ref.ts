import * as Automerge from "@automerge/automerge/slim"
import type { Doc, Prop, Heads } from "@automerge/automerge/slim"
import type { DocHandle, DocHandleChangePayload } from "../DocHandle.js"
import { encodeHeads, decodeHeads } from "../AutomergeUrl.js"
import type {
  Segment,
  PathSegment,
  CursorRange,
  AnyPathInput,
  Pattern,
  InferRefType,
  ChangeFn,
  RefUrl,
  Ref,
} from "./types.js"
import { KIND } from "./types.js"
import { isSegment, isPattern } from "./guards.js"
import { matchesPattern } from "./utils.js"
import { isCursorMarker } from "./guards.js"
import type { CursorMarker } from "./types.js"
import { stringifyRefUrl } from "./parser.js"
import { MutableText } from "./mutable-text.js"

/**
 * FinalizationRegistry for automatic cleanup of Ref instances.
 * This ensures subscriptions are cleaned up when Refs are garbage collected,
 * even if dispose() is never called.
 */
const refCleanupRegistry = new FinalizationRegistry<() => void>((cleanup) =>
  cleanup()
)

/**
 * Internal implementation of the Ref interface.
 *
 * Refs are stable by default - they track objects by ID, not position.
 *
 * Cleanup: Refs automatically clean up their subscriptions when garbage collected.
 *
 * @internal Use DocHandle.ref() to create refs, not this class directly.
 */
export class RefImpl<
  TDoc = any,
  TPath extends readonly AnyPathInput[] = AnyPathInput[],
> implements Ref<InferRefType<TDoc, TPath>> {
  readonly docHandle: DocHandle<TDoc>
  readonly path: PathSegment[]
  readonly range?: CursorRange

  #onChangeCallbacks = new Set<
    (payload: DocHandleChangePayload<any>) => void
  >()
  #updateHandler: () => void

  constructor(
    docHandle: DocHandle<TDoc>,
    segments: readonly [...TPath]
  ) {
    this.docHandle = docHandle

    const doc = docHandle.doc()
    const { path, range } = this.#normalizePath(
      doc,
      segments as unknown as AnyPathInput[]
    )
    this.path = path
    this.range = range

    this.#updateHandler = () => {
      const currentDoc = this.docHandle.doc()
      this.#updateProps(currentDoc)
    }
    this.docHandle.on("change", this.#updateHandler)

    // Register for automatic cleanup when this Ref is garbage collected
    refCleanupRegistry.register(this, () => this.#cleanup(), this)
  }

  #cleanup(): void {
    this.docHandle.off("change", this.#updateHandler)
    for (const callback of this.#onChangeCallbacks) {
      this.docHandle.off("change", callback)
    }
    this.#onChangeCallbacks.clear()
  }

  get rangePositions(): [number, number] | undefined {
    if (!this.range) return undefined
    const propPath = this.#getPropPath()
    if (!propPath) return undefined
    const doc = this.doc()
    return this.#getRangePositions(doc, propPath, this.range)
  }

  viewAt(heads: Heads): Ref<InferRefType<TDoc, TPath>> {
    const viewHandle = this.docHandle.view(encodeHeads(heads))
    return viewHandle.ref(...(this.path as any)) as Ref<
      InferRefType<TDoc, TPath>
    >
  }

  value(): InferRefType<TDoc, TPath> | undefined {
    const doc = this.doc()
    const propPath = this.#getPropPath()
    if (!propPath) return undefined

    const value = this.#getValueAt(doc, propPath)

    return (
      this.range ? this.#extractRange(doc, propPath, value, this.range) : value
    ) as InferRefType<TDoc, TPath> | undefined
  }

  doc(): Doc<TDoc> {
    return this.docHandle.doc()
  }

  change(
    fnOrValue: ChangeFn<InferRefType<TDoc, TPath>> | InferRefType<TDoc, TPath>
  ): void {
    if (this.docHandle.isReadOnly()) {
      throw new Error("Cannot change a Ref on a read-only handle")
    }

    // Convert direct value to function form
    const fn: ChangeFn<InferRefType<TDoc, TPath>> =
      typeof fnOrValue === "function"
        ? (fnOrValue as ChangeFn<InferRefType<TDoc, TPath>>)
        : () => fnOrValue as InferRefType<TDoc, TPath>

    this.docHandle.change((doc: Doc<TDoc>) => {
      if (this.path.length === 0 && !this.range) {
        fn(doc as any)
        return
      }

      const propPath = this.#getPropPath()
      if (!propPath) throw new Error("Cannot resolve path")

      let current: any
      if (this.range) {
        const parent = this.#getValueAt(doc, propPath)
        if (typeof parent !== "string") {
          throw new Error("Range refs can only be used on string values")
        }
        current = this.#extractRange(doc, propPath, parent, this.range)
      } else {
        current = this.#getValueAt(doc, propPath)
      }

      // If current is a string, wrap it in MutableText
      const valueToPass =
        typeof current === "string"
          ? MutableText(doc, propPath, current)
          : current

      const newValue = fn(valueToPass)
      if (newValue === undefined) return

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
        )
      }

      if (this.range) {
        this.#spliceRange(doc, propPath, this.range, newValue as string)
      } else {
        this.#setValueAt(doc, propPath, newValue)
      }
    })
  }

  remove(): void {
    if (this.docHandle.isReadOnly()) {
      throw new Error("Cannot remove from a Ref on a read-only handle")
    }

    if (this.path.length === 0 && !this.range) {
      throw new Error("Cannot remove the root document")
    }

    this.docHandle.change((doc: Doc<TDoc>) => {
      const propPath = this.#getPropPath()
      if (!propPath || propPath.length === 0) {
        throw new Error("Cannot resolve path for removal")
      }

      // Handle range refs - delete the text within the range
      if (this.range) {
        this.#spliceRange(doc, propPath, this.range, "")
        return
      }

      const parentPath = propPath.slice(0, -1)
      const key = propPath[propPath.length - 1]
      const parent =
        parentPath.length === 0 ? doc : this.#getValueAt(doc, parentPath)

      if (parent == null) {
        throw new Error("Cannot remove: parent is null or undefined")
      }

      if (Array.isArray(parent)) {
        if (typeof key !== "number") {
          throw new Error("Cannot remove from array: key is not a number")
        }
        parent.splice(key, 1)
      } else {
        delete parent[key]
      }
    })
  }

  onChange(
    callback: (
      value: InferRefType<TDoc, TPath> | undefined,
      payload: DocHandleChangePayload<any>
    ) => void
  ): () => void {
    const wrappedCallback = (payload: DocHandleChangePayload<any>) => {
      if (this.#patchAffectsRef(payload.patches)) {
        const value = this.value()
        callback(value, payload)
      }
    }

    this.docHandle.on("change", wrappedCallback)

    // Track this callback so it can be cleaned up in dispose()
    this.#onChangeCallbacks.add(wrappedCallback)

    const unsubscribe = () => {
      this.docHandle.off("change", wrappedCallback)
      this.#onChangeCallbacks.delete(wrappedCallback)
    }

    return unsubscribe
  }

  get url(): RefUrl {
    const allSegments: Segment[] = this.range
      ? [...this.path, this.range]
      : this.path

    // Include heads in URL only for read-only (time-traveled) handles
    const heads = this.docHandle.isReadOnly()
      ? decodeHeads(this.docHandle.heads())
      : undefined

    return stringifyRefUrl(this.docHandle.documentId, allSegments, heads)
  }

  equals(other: Ref<unknown>): boolean {
    return this.url === other.url
  }

  contains(other: Ref<unknown>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== other.docHandle.documentId) {
      return false
    }

    // Must have same heads (compare handle URLs which include heads for read-only handles)
    if (this.docHandle.url !== other.docHandle.url) {
      return false
    }

    // This path must be a prefix of other's path
    if (this.path.length >= other.path.length) {
      return false
    }

    // Check if all segments match
    for (let i = 0; i < this.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], other.path[i])) {
        return false
      }
    }

    return true
  }

  isChildOf(parent: Ref<unknown>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== parent.docHandle.documentId) {
      return false
    }

    // Must have same heads (compare handle URLs which include heads for read-only handles)
    if (this.docHandle.url !== parent.docHandle.url) {
      return false
    }

    // Check if paths match up to parent's length
    if (this.path.length < parent.path.length) {
      return false
    }

    // All of parent's path segments must match
    for (let i = 0; i < parent.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], parent.path[i])) {
        return false
      }
    }

    // Case 1: Same path length - only valid if this has a range and parent doesn't
    // (this is a range child of text)
    if (this.path.length === parent.path.length) {
      return this.range !== undefined && parent.range === undefined
    }

    // Case 2: Path is exactly one segment longer (direct child)
    if (this.path.length === parent.path.length + 1) {
      return true
    }

    // Case 3: Path is more than one segment longer (not a direct child)
    return false
  }

  overlaps(other: Ref<unknown>): boolean {
    // Must be same document
    if (this.docHandle.documentId !== other.docHandle.documentId) {
      return false
    }

    // Must have same heads (compare handle URLs which include heads for read-only handles)
    if (this.docHandle.url !== other.docHandle.url) {
      return false
    }

    // Both must have ranges
    if (!this.range || !other.range) {
      return false
    }

    // Paths must be identical (same parent location)
    if (this.path.length !== other.path.length) {
      return false
    }

    for (let i = 0; i < this.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], other.path[i])) {
        return false
      }
    }

    // Check if ranges overlap
    // Get the numeric positions for both ranges
    const doc = this.doc()
    const propPath = this.#getPropPath()
    if (!propPath) return false

    const thisPositions = this.#getRangePositions(doc, propPath, this.range)
    const otherPositions = this.#getRangePositions(doc, propPath, other.range)

    if (!thisPositions || !otherPositions) return false

    const [thisStart, thisEnd] = thisPositions
    const [otherStart, otherEnd] = otherPositions

    // Ranges overlap if: thisStart < otherEnd && otherStart < thisEnd
    return thisStart < otherEnd && otherStart < thisEnd
  }

  isEquivalent(other: Ref<unknown>): boolean {
    // Fast path: identity check
    if (this === other) {
      return true
    }

    // Different documents can't be equivalent
    if (this.docHandle.documentId !== other.docHandle.documentId) {
      return false
    }

    // Check heads equivalence
    // undefined heads means "current document state"
    // If one has undefined and other has explicit heads, check if they match current
    if (!this.#headsEquivalent(other)) {
      return false
    }

    // Different path lengths can't be equivalent
    if (this.path.length !== other.path.length) {
      return false
    }

    // Check range presence mismatch
    if ((this.range === undefined) !== (other.range === undefined)) {
      return false
    }

    // Fast path: if segments are structurally equal, they're equivalent
    let segmentsEqual = true
    for (let i = 0; i < this.path.length; i++) {
      if (!this.#segmentsEqual(this.path[i], other.path[i])) {
        segmentsEqual = false
        break
      }
    }

    if (segmentsEqual) {
      // Same path structure, now check ranges
      if (!this.range && !other.range) {
        return true
      }
      // Both have ranges (checked above), compare them
      return (
        this.range!.start === other.range!.start &&
        this.range!.end === other.range!.end
      )
    }

    // Segments differ structurally - check if they resolve to the same prop path
    // Note: we access other.path[i].prop directly (public) instead of calling
    // private methods on other, since other may be from a different bundle
    for (let i = 0; i < this.path.length; i++) {
      const thisProp = this.path[i].prop
      const otherProp = other.path[i].prop

      // If either can't be resolved, they're not equivalent
      if (thisProp === undefined || otherProp === undefined) {
        return false
      }

      if (thisProp !== otherProp) {
        return false
      }
    }

    // Prop paths match, now check ranges
    if (!this.range && !other.range) {
      return true
    }

    // Both have ranges - compare cursor values
    return (
      this.range!.start === other.range!.start &&
      this.range!.end === other.range!.end
    )
  }

  valueOf(): string {
    return this.url
  }

  toString(): string {
    return this.url
  }

  /**
   * Check if this ref's heads are equivalent to another ref's heads.
   * A ref on a non-read-only handle represents "current document state",
   * so it's equivalent to a ref on a read-only handle with heads matching the current document.
   */
  #headsEquivalent(other: Ref<unknown>): boolean {
    // If both handles have the same URL (including heads for read-only handles), they're equivalent
    if (this.docHandle.url === other.docHandle.url) {
      return true
    }

    // Get effective heads for each - use handle's heads (which is current for non-read-only)
    const thisHeadsStr = this.docHandle.heads().join(",")
    const otherHeadsStr = other.docHandle.heads().join(",")

    return thisHeadsStr === otherHeadsStr
  }

  /**
   * Normalize path inputs and extract stable IDs where possible.
   */
  #normalizePath(
    doc: Doc<TDoc>,
    inputs: AnyPathInput[]
  ): { path: PathSegment[]; range?: CursorRange } {
    const pathSegments: PathSegment[] = []
    const propPath: Automerge.Prop[] = []
    let current: any = doc
    let rangeSegment: CursorRange | undefined

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]

      // Handle cursor() marker - creates cursor-based range
      if (isCursorMarker(input)) {
        // cursor() must be the last segment
        if (i < inputs.length - 1) {
          throw new Error(
            "cursor() must be the last segment in a ref path. " +
              "Segments after cursor() are not allowed."
          )
        }
        rangeSegment = this.#createCursorRange(doc, propPath, current, input)
        break
      }

      const segment = isSegment(input)
        ? this.#ensureSegmentResolved(current, input)
        : this.#normalizeInput(current, input)

      if (segment[KIND] === "cursors") {
        // Cursor range from URL parsing - must also be last
        if (i < inputs.length - 1) {
          throw new Error(
            "Cursor range must be the last segment in a ref path. " +
              "Segments after cursor range are not allowed."
          )
        }
        rangeSegment = segment
        break
      }

      pathSegments.push(segment)

      if (
        segment.prop !== undefined &&
        current !== undefined &&
        current !== null
      ) {
        propPath.push(segment.prop)
        current = current[segment.prop]
      }
    }

    return { path: pathSegments, range: rangeSegment }
  }

  /** Ensure a segment has its prop set */
  #ensureSegmentResolved(container: any, segment: Segment): Segment {
    const prop = this.#resolveSegmentProp(container, segment)
    return { ...segment, prop } as Segment
  }

  /**
   * Resolve a path segment to its Automerge prop.
   * Returns undefined if the segment cannot be resolved.
   */
  #resolveSegmentProp(
    container: any,
    segment: Segment
  ): string | number | undefined {
    if (container === undefined || container === null) return undefined

    switch (segment[KIND]) {
      case "key":
        return segment.key

      case "index":
        return segment.index

      case "match": {
        if (!Array.isArray(container)) return undefined
        const matchIndex = container.findIndex((item) =>
          matchesPattern(item, segment.match)
        )
        return matchIndex !== -1 ? matchIndex : undefined
      }
      case "cursors":
        return undefined

      default:
        segment satisfies never
        return undefined
    }
  }

  /** Update resolved props for all path segments based on current document state */
  #updateProps(doc: Doc<TDoc>): void {
    let current = doc

    for (const segment of this.path) {
      const prop = this.#resolveSegmentProp(current, segment)
      // Internal mutation: Update cached prop for efficient path resolution.
      // Safe because segments are owned by this Ref instance.
      segment.prop = prop

      if (prop !== undefined && current !== undefined && current !== null) {
        current = (current as any)[prop]
      } else {
        break
      }
    }
  }

  /**
   * Check if two PathSegments are equal.
   * Used by `contains` and `overlaps` methods.
   */
  #segmentsEqual(a: PathSegment, b: PathSegment): boolean {
    if (a[KIND] !== b[KIND]) {
      return false
    }

    switch (a[KIND]) {
      case "key":
        return a.key === (b as typeof a).key
      case "index":
        return a.index === (b as typeof a).index
      case "match": {
        const aKeys = Object.keys(a.match)
        const bKeys = Object.keys((b as typeof a).match)
        if (aKeys.length !== bKeys.length) return false
        return aKeys.every(
          (key) => a.match[key] === (b as typeof a).match[key]
        )
      }
      default:
        a satisfies never
        return false
    }
  }

  #normalizeInput(container: any, input: string | number | Pattern): Segment {
    if (typeof input === "string") {
      return { [KIND]: "key", key: input, prop: input }
    }

    if (typeof input === "number") {
      return { [KIND]: "index", index: input, prop: input }
    }

    if (isPattern(input)) {
      if (!Array.isArray(container)) {
        return { [KIND]: "match", match: input, prop: undefined }
      }

      const index = container.findIndex((obj) => matchesPattern(obj, input))
      return {
        [KIND]: "match",
        match: input,
        prop: index !== -1 ? index : undefined,
      }
    }

    throw new Error(
      `Unsupported path input type: ${typeof input}. ` +
        `Expected string, number, or plain object.`
    )
  }

  /** Create a cursor-based range from a CursorMarker */
  #createCursorRange(
    doc: Doc<TDoc>,
    propPath: Automerge.Prop[],
    container: any,
    marker: CursorMarker
  ): CursorRange {
    const { start, end } = marker

    if (typeof container !== "string") {
      throw new Error(
        `cursor() can only be used on string values, got ${typeof container}`
      )
    }

    const startCursor = Automerge.getCursor(doc, propPath, start)
    const endCursor = Automerge.getCursor(doc, propPath, end)

    if (!startCursor || !endCursor) {
      throw new Error(`Failed to create cursors at positions ${start}-${end}.`)
    }

    return { [KIND]: "cursors", start: startCursor, end: endCursor }
  }

  /** Extract cached navigation path from segments */
  #getPropPath(): Prop[] | undefined {
    const props: Prop[] = []
    for (const segment of this.path) {
      if (segment.prop === undefined) return undefined
      props.push(segment.prop)
    }
    return props
  }

  /** Navigate to a value by following a prop path */
  #getValueAt(container: any, propPath: Prop[]): any {
    let current = container
    for (const prop of propPath) {
      if (current == null) return undefined
      current = current[prop]
    }
    return current
  }

  /** Extract substring from a text value using a range */
  #extractRange(
    doc: Doc<TDoc>,
    propPath: Prop[],
    text: string,
    range: CursorRange
  ): string | undefined {
    const positions = this.#getRangePositions(doc, propPath, range)
    if (!positions) return undefined
    return text.slice(positions[0], positions[1])
  }
  /** Set a value at a prop path (change-only: mutates the doc proxy) */
  #setValueAt(container: any, propPath: Prop[], value: any): void {
    if (propPath.length === 0) {
      throw new Error(
        "Internal error: #setValueAt called with empty path. " +
          "Root document changes should be handled by the caller."
      )
    }
    const parent = this.#getValueAt(container, propPath.slice(0, -1))
    if (parent == null) {
      throw new Error("Cannot set value: parent is null or undefined")
    }
    parent[propPath[propPath.length - 1]] = value
  }

  /** Replace a substring at a range using Automerge.splice (change-only: mutates the doc proxy) */
  #spliceRange(
    doc: Doc<TDoc>,
    propPath: Prop[],
    range: CursorRange,
    newValue: string
  ): void {
    const positions = this.#getRangePositions(doc, propPath, range)
    if (!positions) {
      throw new Error("Cannot resolve range positions")
    }

    const [start, end] = positions
    Automerge.splice(doc, propPath, start, end - start, newValue)
  }

  /** Convert cursor positions to numeric [start, end] positions */
  #getRangePositions(
    doc: Doc<TDoc>,
    propPath: Prop[],
    range: CursorRange
  ): [number, number] | undefined {
    const start = Automerge.getCursorPosition(doc, propPath, range.start)
    const end = Automerge.getCursorPosition(doc, propPath, range.end)

    return start !== undefined && end !== undefined ? [start, end] : undefined
  }

  #patchAffectsRef(patches: Automerge.Patch[]): boolean {
    const refPropPath: Prop[] = []
    for (const segment of this.path) {
      if (segment.prop === undefined) break
      refPropPath.push(segment.prop)
    }

    // If we couldn't resolve any part, ref was never valid - don't fire
    if (refPropPath.length === 0) return false

    return patches.some((patch) => this.#pathsOverlap(patch.path, refPropPath))
  }

  #pathsOverlap(
    patchPath: Automerge.Prop[],
    refPropPath: Automerge.Prop[]
  ): boolean {
    const minLength = Math.min(patchPath.length, refPropPath.length)
    return patchPath
      .slice(0, minLength)
      .every((prop, i) => prop === refPropPath[i])
  }
}

