import type { Prop } from "@automerge/automerge/slim"
import type { UrlHeads } from "../types.js"
import { KIND } from "./types.js"
import type { PathSegment, Pattern, ResolvedPathSegment } from "./types.js"

/** Helpers over symbolic path segments, shared by handles and the registry. */

/**
 * Thrown when a path is built with an empty-string key. Empty keys don't
 * round-trip through URLs (`automerge:docId/` parses as no path), so we
 * reject them at construction rather than silently dropping them later.
 */
export class EmptyKeyError extends Error {
  constructor() {
    super(
      "Empty-string keys are not supported in sub-handle paths: they do not round-trip through URLs."
    )
    this.name = "EmptyKeyError"
  }
}

/** Strip non-symbolic fields (e.g. legacy `prop`) from an incoming segment. */
export function symbolicOnly(seg: PathSegment): PathSegment {
  switch (seg[KIND]) {
    case "key":
      if (seg.key === "") throw new EmptyKeyError()
      return { [KIND]: "key", key: seg.key }
    case "index":
      return { [KIND]: "index", index: seg.index }
    case "match":
      return { [KIND]: "match", match: seg.match }
  }
}

/**
 * Build the `ResolvedPathSegment[]` snapshot for `DocHandle.path` by zipping
 * symbolic segments with resolved props. Trailing segments after a failed
 * pattern carry `prop: undefined`.
 */
export function zipResolvedSegments(
  symbolic: readonly PathSegment[],
  resolved: Prop[] | undefined
): ResolvedPathSegment[] {
  const out: ResolvedPathSegment[] = []
  const n = resolved?.length ?? 0
  for (let i = 0; i < symbolic.length; i++) {
    const seg = symbolic[i]
    const prop = i < n ? (resolved as Prop[])[i] : undefined
    switch (seg[KIND]) {
      case "key":
        out.push({ [KIND]: "key", key: seg.key, prop: seg.key })
        break
      case "index":
        out.push({ [KIND]: "index", index: seg.index, prop: seg.index })
        break
      case "match":
        out.push({
          [KIND]: "match",
          match: seg.match,
          prop: prop as number | undefined,
        })
        break
    }
  }
  return out
}

/** True iff two `#fixedHeads` arrays describe the same view. */
export function sameFixedHeads(
  a: UrlHeads | undefined,
  b: UrlHeads | undefined
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** True iff one path prefixes the other (or they're equal). */
export function isPathPrefixCompatible(
  a: readonly Prop[],
  b: readonly Prop[]
): boolean {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/** Structural equality for symbolic segments. */
export function segmentEquals(a: PathSegment, b: PathSegment): boolean {
  if (a[KIND] !== b[KIND]) return false
  switch (a[KIND]) {
    case "key":
      return a.key === (b as { key: string }).key
    case "index":
      return a.index === (b as { index: number }).index
    case "match": {
      const am = a.match
      const bm = (b as { match: Pattern }).match
      const ka = Object.keys(am)
      const kb = Object.keys(bm)
      if (ka.length !== kb.length) return false
      for (const k of ka) if (am[k] !== bm[k]) return false
      return true
    }
  }
}
