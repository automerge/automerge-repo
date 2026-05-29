import type * as A from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import { next as Automerge } from "@automerge/automerge/slim"
import type { CursorRange, PathSegment, Pattern } from "./types.js"
import { KIND } from "./types.js"
import { MutableText } from "./mutable-text.js"
import { matchesPattern } from "./utils.js"

/**
 * Path-scoped operations on a document: resolve a symbolic path against
 * a doc snapshot, read the value, apply a change, remove the slot. All
 * resolution is on-the-fly against the passed-in `doc` - segments carry
 * no resolved state (the registry caches resolved pattern indices).
 */

/**
 * Walk symbolic `segments` against `doc`, producing the concrete prop
 * path. Returns `undefined` if any pattern segment fails to match an
 * item in its parent array.
 */
export function resolvePropPath(
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
 * Resolve a single segment against its parent container. `key`/`index`
 * return their literal value regardless of whether the parent exists -
 * they're symbolic. `match` requires a real parent array to scan and
 * returns the index of the first matching item (or `undefined`).
 */
export function resolveSegmentProp(
  container: unknown,
  segment: PathSegment
): string | number | undefined {
  switch (segment[KIND]) {
    case "key":
      return segment.key
    case "index":
      return segment.index
    case "match": {
      if (!Array.isArray(container)) return undefined
      const idx = (container as unknown[]).findIndex(item =>
        matchesPattern(item, segment.match as Pattern)
      )
      return idx !== -1 ? idx : undefined
    }
  }
}

/**
 * Re-base patches that overlap a scope `prefixLength` segments deep so they
 * read *relative to that scope*. Callers must pre-filter to patches that
 * overlap the scope (inside it or at/above its boundary); given that, the
 * split is purely by path length:
 *  - `path.length > prefixLength`  - inside the scope; re-root by slicing
 *    off the prefix.
 *  - `path.length <= prefixLength` - the scope itself (or an ancestor) was
 *    replaced or removed; there's no in-scope path for it, so it's reported
 *    via the `scopeReplaced` flag and dropped from the patch list.
 *
 * For a root scope (`prefixLength === 0`) this is the identity.
 */
export function rebasePatchesToScope(
  patches: readonly A.Patch[],
  prefixLength: number
): { patches: A.Patch[]; scopeReplaced: boolean } {
  if (prefixLength === 0) {
    return { patches: patches as A.Patch[], scopeReplaced: false }
  }
  const out: A.Patch[] = []
  let scopeReplaced = false
  for (const p of patches) {
    if (p.path.length <= prefixLength) {
      scopeReplaced = true
      continue
    }
    out.push({ ...p, path: p.path.slice(prefixLength) } as A.Patch)
  }
  return { patches: out, scopeReplaced }
}

/**
 * Read the value at the resolved `propPath` (or the substring within a
 * cursor range). Returns `undefined` if `propPath` is `undefined` (the
 * symbolic path didn't fully resolve) or if any intermediate value is
 * nullish.
 */
export function scopedValue(
  doc: A.Doc<any>,
  propPath: Prop[] | undefined,
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined
): unknown {
  if (!propPath) return undefined
  let cursor: unknown = doc
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
 * Apply a change to the value at the resolved `propPath`.
 *
 * `fn` is either a mutator function or a plain replacement value, and that
 * distinction alone decides the behavior - no caller flag needed:
 *
 * - A **function** is a mutator. Containers (objects/arrays) are mutated in
 *   place and the return value is ignored, exactly like `A.change` on the root
 *   document, so a stray arrow-expression return (`sub.change(d => (d.x = 1))`)
 *   can't accidentally replace the whole container. Primitives have no in-place
 *   proxy, so their callback's return value sets the slot. Strings are wrapped
 *   in {@link MutableText} for CRDT-safe `.splice` / `.updateText` edits, or a
 *   returned string replaces the text.
 * - A **non-function value** is the shorthand replacement form
 *   (`sub.change(newValue)`) and overwrites the slot - including containers.
 */
export function applyScopedChange(
  doc: A.Doc<any>,
  propPath: Prop[] | undefined,
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined,
  fn: A.ChangeFn<any> | unknown
): A.Doc<any> {
  // A function is a mutator; anything else is a replacement value.
  const isReplacement = typeof fn !== "function"

  if (propPath !== undefined && propPath.length === 0 && !range) {
    if (isReplacement || (fn as any)(doc) !== undefined) {
      throw new Error(
        "Cannot return a new value for the root document; mutate it in place instead."
      )
    }
    return doc
  }

  if (!propPath) return doc
  const currentValue = readAt(doc, propPath)

  if (range) {
    if (typeof currentValue !== "string") {
      throw new Error("cursor() can only be used on string values")
    }
    const positions = rangePositions()
    if (!positions) return doc
    const [start, end] = positions
    const existingSubstring = currentValue.slice(start, end)
    // Range scope receives the same boxed-String editor, offset to its span, so
    // `splice`/`updateText` act within the range. A returned primitive string
    // splices the new value into [start, end).
    const result = isReplacement
      ? fn
      : (fn as any)(MutableText(doc, propPath, existingSubstring, { start }))
    if (typeof result === "string") {
      Automerge.splice(doc, propPath, start, end - start, result)
    }
    return doc
  }

  if (
    currentValue !== null &&
    (typeof currentValue === "object" || Array.isArray(currentValue))
  ) {
    // Replacement overwrites the slot; a mutator runs in place and its return
    // value is ignored (like `A.change` on the root document).
    if (isReplacement) {
      setAt(doc, propPath, fn)
    } else {
      ;(fn as any)(currentValue)
    }
    return doc
  }

  if (typeof currentValue === "string") {
    if (isReplacement) {
      if (typeof fn === "string") {
        Automerge.updateText(doc, propPath, fn)
      } else {
        setAt(doc, propPath, fn)
      }
      return doc
    }
    const mt = MutableText(doc, propPath, currentValue)
    const result = (fn as any)(mt)
    if (typeof result === "string") {
      Automerge.updateText(doc, propPath, result)
    }
    return doc
  }

  // Primitive / undefined slot - no in-place proxy, so the replacement value
  // (or the mutator's return value) sets the slot.
  const result = isReplacement ? fn : (fn as any)(currentValue)
  if (result !== undefined) {
    setAt(doc, propPath, result)
  }
  return doc
}

/** Remove the value at the resolved `propPath`. */
export function applyScopedRemove(
  doc: A.Doc<any>,
  propPath: Prop[] | undefined,
  range: CursorRange | undefined,
  rangePositions: () => [number, number] | undefined
): A.Doc<any> {
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
