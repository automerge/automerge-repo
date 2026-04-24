import type * as A from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import { next as Automerge } from "@automerge/automerge/slim"
import type { CursorRange, PathSegment, Pattern } from "./types.js"
import { KIND } from "./types.js"
import { MutableText } from "./mutable-text.js"
import { matchesPattern } from "./utils.js"

/**
 * Path-scoped operations on a document: resolve a path, read the value at
 * the path, apply a change to the value at the path, remove the slot at
 * the path. Used by `DocHandle` (which carries the path/range) to drive
 * sub-handle reads and mutations through the shared underlying doc.
 */

/** The resolved numeric/string prop path for use with Automerge APIs. */
export function getPropPath(
  segments: readonly PathSegment[]
): Prop[] | undefined {
  const propPath: Prop[] = []
  for (const seg of segments) {
    if (seg.prop === undefined) return undefined
    propPath.push(seg.prop)
  }
  return propPath
}

/**
 * Read the value at a sub-handle's path (or the substring within a cursor
 * range). Pure read: assumes `segment.prop` values are already fresh for
 * `rootView`. Callers are responsible for refreshing first - DocHandle
 * does this with a doc-identity cache (see `#refreshIfStale`) so reads
 * are O(pathLen) when the underlying doc hasn't moved.
 */
export function scopedValue(
  rootView: A.Doc<any>,
  segments: readonly PathSegment[],
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined
): unknown {
  const propPath = getPropPath(segments)
  if (!propPath) return undefined
  let cursor: unknown = rootView
  for (const p of propPath) {
    if (cursor == null) return undefined
    cursor = (cursor as any)[p as any]
  }
  if (range) {
    if (typeof cursor !== "string") return undefined
    const [start, end] = rangePositions() ?? [0, 0]
    return cursor.slice(start, end)
  }
  return cursor
}

/**
 * Apply a change callback to the value at a sub-handle's path. Mutations
 * are made in place; returning a non-`undefined` primitive value from the
 * callback replaces the slot. Strings are wrapped in {@link MutableText}
 * so callbacks can `.splice` / `.updateText` for CRDT-safe edits.
 *
 * Pure read of `segment.prop`s; callers must ensure segments are fresh
 * for the passed-in doc (see {@link scopedValue}).
 */
export function applyScopedChange(
  doc: A.Doc<any>,
  segments: readonly PathSegment[],
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined,
  fn: A.ChangeFn<any>
): A.Doc<any> {
  const propPath = getPropPath(segments)
  if (!propPath) return doc
  if (segments.length === 0 && !range) {
    const result = (fn as any)(doc)
    if (result !== undefined) {
      throw new Error(
        "Cannot return a new value for the root document; mutate it in place instead."
      )
    }
    return doc
  }

  const currentValue = readAt(doc, propPath)

  if (range) {
    if (typeof currentValue !== "string") {
      throw new Error("cursor() can only be used on string values")
    }
    const positions = rangePositions()
    if (!positions) return doc
    const [start, end] = positions
    const existingSubstring = currentValue.slice(start, end)
    const result = (fn as any)(existingSubstring)
    if (typeof result === "string") {
      Automerge.splice(doc, propPath, start, end - start, result)
    }
    return doc
  }

  if (
    currentValue !== null &&
    (typeof currentValue === "object" || Array.isArray(currentValue))
  ) {
    const result = (fn as any)(currentValue)
    if (result !== undefined) {
      setAt(doc, propPath, result)
    }
    return doc
  }

  if (typeof currentValue === "string") {
    const mt = MutableText(doc, propPath, currentValue)
    const result = (fn as any)(mt)
    if (typeof result === "string") {
      Automerge.updateText(doc, propPath, result)
    }
    return doc
  }

  // Primitive / undefined — callback's return value replaces the slot.
  const result = (fn as any)(currentValue)
  if (result !== undefined) {
    setAt(doc, propPath, result)
  }
  return doc
}

/**
 * Remove the value at a sub-handle's path. Pure read of `segment.prop`s;
 * callers must ensure segments are fresh (see {@link scopedValue}).
 */
export function applyScopedRemove(
  doc: A.Doc<any>,
  segments: readonly PathSegment[],
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined
): A.Doc<any> {
  const propPath = getPropPath(segments)
  if (!propPath || propPath.length === 0) return doc

  if (range) {
    const positions = rangePositions()
    if (!positions) return doc
    const [start, end] = positions
    Automerge.splice(doc, propPath, start, end - start, "")
    return doc
  }

  const parentPath = propPath.slice(0, -1)
  const leaf = propPath[propPath.length - 1]
  let parent: any = doc
  for (const p of parentPath) parent = (parent as any)[p as any]
  if (Array.isArray(parent) && typeof leaf === "number") {
    ;(parent as any).deleteAt(leaf)
  } else {
    delete parent[leaf as any]
  }
  return doc
}

/**
 * Resolve a single path segment against the value at its parent position.
 *
 *  - `key`: always returns the segment's static key, regardless of whether
 *    the parent actually exists in the document. The prop is a symbolic
 *    name, not a value lookup - a segment for `"title"` resolves to
 *    `"title"` even if the intermediate path doesn't reach an object.
 *  - `index`: always returns the segment's static index, same reasoning.
 *  - `match`: needs a real parent array to scan. Returns `undefined` if
 *    the parent is missing, not an array, or has no matching item.
 *
 * Pure - does not mutate the segment. Use {@link updatePropsFromRoot} when
 * you want to write the resolution back onto `segment.prop`.
 */
export function resolveSegmentProp(
  container: unknown,
  segment: PathSegment
): string | number | undefined {
  switch ((segment as any)[KIND]) {
    case "key":
      return (segment as any).key
    case "index":
      return (segment as any).index
    case "match": {
      if (container === undefined || container === null) return undefined
      if (!Array.isArray(container)) return undefined
      const match = (segment as any).match as Pattern
      const idx = (container as unknown[]).findIndex(item =>
        matchesPattern(item, match)
      )
      return idx !== -1 ? idx : undefined
    }
    default:
      return undefined
  }
}

/**
 * Resolve symbolic path segments against a given document snapshot.
 * Returns the concrete prop path, or `undefined` if any segment fails to
 * resolve (e.g. a pattern with no matching item).
 *
 * Pure - does not mutate `segment.prop`. Used by `history()` and `diff()`
 * to scope patches to what the path meant at the *historical* state the
 * patches describe, since pattern-based segments can resolve to different
 * indices at different points in history.
 */
export function resolvePropPathAt(
  doc: A.Doc<any> | undefined,
  segments: readonly PathSegment[]
): Prop[] | undefined {
  if (!doc) return undefined
  const out: Prop[] = []
  let cursor: unknown = doc
  for (const seg of segments) {
    const prop = resolveSegmentProp(cursor, seg)
    if (prop === undefined) return undefined
    out.push(prop)
    cursor =
      cursor === null || cursor === undefined
        ? undefined
        : (cursor as any)[prop as any]
  }
  return out
}

/**
 * Re-resolve `segment.prop` for each segment against `rootDoc` and write
 * the result back to the segment. The mutating counterpart of
 * {@link resolvePropPathAt}; called by {@link scopedValue} /
 * {@link applyScopedChange} / {@link applyScopedRemove} so reads always
 * see up-to-date pattern resolutions for the doc passed in.
 */
export function updatePropsFromRoot(
  rootDoc: A.Doc<any> | undefined,
  segments: readonly PathSegment[],
  resolver: (
    cursor: unknown,
    segment: PathSegment
  ) => Prop | undefined = resolveSegmentProp
): void {
  if (!rootDoc) return
  let cursor: unknown = rootDoc
  for (const segment of segments) {
    const prop = resolver(cursor, segment)
    ;(segment as any).prop = prop
    if (prop !== undefined && cursor !== undefined && cursor !== null) {
      cursor = (cursor as any)[prop as any]
    } else {
      cursor = undefined
    }
  }
}

function readAt(doc: A.Doc<any>, propPath: Prop[]): unknown {
  let cursor: unknown = doc
  for (const p of propPath) {
    if (cursor == null) return undefined
    cursor = (cursor as any)[p as any]
  }
  return cursor
}

function setAt(doc: A.Doc<any>, propPath: Prop[], value: unknown): void {
  const parentPath = propPath.slice(0, -1)
  const leaf = propPath[propPath.length - 1]
  let parent: any = doc
  for (const p of parentPath) parent = (parent as any)[p as any]
  parent[leaf as any] = value
}
