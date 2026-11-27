import type { Pattern, CursorMarker } from "./types.js"
import { CURSOR_MARKER } from "./types.js"

/**
 * Create a cursor-based range segment for stable text selection.
 *
 * Must be used as the last argument in a sub-handle path. Creates stable
 * cursors that track text positions through edits.
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @example
 * ```ts
 * handle.sub('note', cursor(0, 5))  // Cursor-based range on text
 * ```
 */
export function cursor(start: number, end?: number): CursorMarker {
  return { [CURSOR_MARKER]: true, start, end: end ?? start }
}

/**
 * Check if an item matches a pattern.
 *
 * Non-object items (primitives, `null`, `undefined`) never match a
 * pattern - so a pattern segment over a mixed array simply skips them
 * rather than throwing.
 *
 * Note: This performs shallow equality checks only. Nested objects
 * are compared by reference, not by deep value equality.
 *
 * @internal
 */
export function matchesPattern(item: any, pattern: Pattern): boolean {
  if (item === null || typeof item !== "object") return false
  return Object.entries(pattern).every(([key, value]) => item[key] === value)
}
