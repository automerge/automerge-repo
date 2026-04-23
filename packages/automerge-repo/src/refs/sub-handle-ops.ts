import type * as A from "@automerge/automerge/slim"
import type { Prop, ChangeFn } from "@automerge/automerge/slim"
import { next as Automerge } from "@automerge/automerge/slim"
import type { CursorRange, PathSegment, Pattern } from "./types.js"
import { KIND } from "./types.js"
import { MutableText } from "./mutable-text.js"
import { matchesPattern } from "./utils.js"

// Alias: mirror the "RefChangeFn" name used in DocHandle for symmetry with the
// historical Ref.change signature. Functionally identical to Automerge's ChangeFn.
type RefChangeFn<T> = ChangeFn<T>

/**
 * Pure helpers that encapsulate the "sub-handle"-specific behaviour on a `DocHandle`:
 * resolving the current prop path, reading the scoped value, and applying scoped
 * mutations.
 *
 * Keeping these in one module (rather than as private methods scattered across
 * `DocHandle`) makes the set of operations that a sub-handle adds over a root
 * handle explicit, and makes it cheap to evolve the scoped-mutation semantics
 * without having to re-find every call site.
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
 * Get the current scoped value (value at path, or substring for a range handle).
 *
 * TODO: lazy `.prop` refresh. Today this function reads the cached
 * `segment.prop` values produced by the most recent `updatePropsFromRoot`
 * pass. That pass is run for every dormant sub-handle on every change
 * (via `DocHandle._dispatchRootChange`), which is the last per-sub-per-
 * change cost in the dispatch path - the thing standing between us and
 * "many thousands of refs are free".
 *
 * The cleaner alternative is to walk segments here against the live
 * `rootView`, resolving each segment with `resolveSegmentProp(cursor, seg)`
 * and writing the result back to `seg.prop` as a side-effect. Then:
 *   - `scopedValue` returns are always up-to-date with the doc passed in.
 *   - `ref.path[i].prop` observations are correct after any `value()` call.
 *   - The dispatch-time `_dispatchRootChange`/`updatePropsFromRoot` path
 *     for dormant subs goes away entirely.
 *
 * The trade-off is "stale `.prop` until you read." Probably fine - users
 * who care about `.prop` either listen for changes (retained) or just
 * called `value()` (which would now refresh).
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
 * Apply a scoped change callback to a mutable view of the document. Mirrors the
 * semantics of the old `Ref.change`: mutations are made in place, and returning a
 * new value from the callback replaces the value at the path.
 */
export function applyScopedChange(
  doc: A.Doc<any>,
  segments: readonly PathSegment[],
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined,
  fn: RefChangeFn<any>
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

/** Remove the value at this handle's path from the mutable document proxy. */
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
 *  - `key`: always returns the segment's static key.
 *  - `index`: always returns the segment's static index.
 *  - `match`: scans the parent array (if any) for the first item matching
 *    the segment's pattern, returning its index. Returns `undefined` if
 *    the parent is not an array or no item matches.
 *
 * Pure - does not mutate the segment. Use
 * {@link updatePropsFromRoot} when you want to write the resolution back
 * onto `segment.prop`.
 */
export function resolveSegmentProp(
  container: unknown,
  segment: PathSegment
): string | number | undefined {
  if (container === undefined || container === null) return undefined
  switch ((segment as any)[KIND]) {
    case "key":
      return (segment as any).key
    case "index":
      return (segment as any).index
    case "match": {
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
 * Resolve a sub-handle's symbolic path segments against a specific document
 * snapshot, returning the concrete numeric/string prop path or `undefined`
 * if any segment fails to resolve (e.g. a pattern has no matching item in
 * that snapshot).
 *
 * Pure: does not mutate any segment `.prop`. Used by `history()` and
 * `diff()` to scope patches to what the sub-handle's path meant *at the
 * historical state the patches describe*, rather than the current state -
 * this is the correctness fix for pattern-based sub-handles whose resolved
 * index changes over time.
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
 * Re-resolve the `prop` on each segment against the current document state. This
 * mutates each segment's `prop` in place so match patterns (and any other
 * kind-specific resolution) track the latest document.
 *
 * The optional `resolver` parameter exists so callers can inject an
 * alternative resolution policy; by default we use {@link resolveSegmentProp}.
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
