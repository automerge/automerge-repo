import type * as A from "@automerge/automerge/slim"
import type { Prop, ChangeFn } from "@automerge/automerge/slim"
import { next as Automerge } from "@automerge/automerge/slim"
import type { CursorRange, PathSegment } from "./types.js"
import { MutableText } from "./mutable-text.js"

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

/** Get the current scoped value (value at path, or substring for a range handle). */
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
 * Re-resolve the `prop` on each segment against the current document state. This
 * mutates each segment's `prop` in place so match patterns (and any other
 * kind-specific resolution) track the latest document.
 */
export function updatePropsFromRoot(
  rootDoc: A.Doc<any> | undefined,
  segments: readonly PathSegment[],
  resolveSegmentProp: (cursor: unknown, segment: PathSegment) => Prop | undefined
): void {
  if (!rootDoc) return
  let cursor: unknown = rootDoc
  for (const segment of segments) {
    const prop = resolveSegmentProp(cursor, segment)
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
