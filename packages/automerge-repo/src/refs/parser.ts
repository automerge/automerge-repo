import * as Automerge from "@automerge/automerge/slim"
import type { RefUrl, Segment, SegmentCodec } from "./types.js"
import { KIND } from "./types.js"
import { DocumentId } from "@automerge/automerge-repo/slim"

/**
 * # Path Segment Encoding Scheme
 *
 * | Type    | Format              | Example                    | Notes                           |
 * |---------|---------------------|----------------------------|---------------------------------|
 * | Key     | string              | `foo`, `my%2Fkey`          | Default, URL-encoded            |
 * | Index   | `@` + number        | `@0`, `@42`                | Array index                     |
 * | Match   | `{...}`             | `{"id":"alice"}`           | JSON object pattern (URL-encoded) |
 * | Cursors | `[start-end]`       | `[2@abc-5@def]`            | Cursor range                    |
 * | Cursors | `[cursor]`          | `[2@abc]`                  | Collapsed (start === end)       |
 *
 * ## Escape Rule
 * If a key starts with `@`, `{`, `[`, or `\`, prefix with `\` (URL-encoded as `%5C`):
 * - `\@at` → key "@at" (appears as `%5C%40at` in URL)
 * - `\{brace` → key "{brace" (appears as `%5C%7Bbrace` in URL)
 * - `\\backslash` → key "\backslash" (appears as `%5C%5Cbackslash` in URL)
 *
 * ## Parsing Priority (first match wins)
 * 1. Index: `@` + digits
 * 2. Match: `{...}` or URL-encoded `%7B...`
 * 3. Cursors: `[...]`
 * 4. Key: `\...` (escaped, URL-encoded as `%5C...`) or anything else
 */

/**
 * # Path Segment Encoding Scheme
 *
 * | Type    | Format              | Example                    | Notes                           |
 * |---------|---------------------|----------------------------|---------------------------------|
 * | Key     | string              | `foo`, `my%2Fkey`          | Default, URL-encoded            |
 * | Index   | `@` + number        | `@0`, `@42`                | Array index                     |
 * | Match   | `{...}`             | `{"id":"alice"}`           | JSON object pattern (URL-encoded) |
 * | Cursors | `[start-end]`       | `[2@abc-5@def]`            | Cursor range                    |
 * | Cursors | `[cursor]`          | `[2@abc]`                  | Collapsed (start === end)       |
 *
 * ## Escape Rule
 * If a key starts with `@`, `{`, `[`, or `\`, prefix with `\` (URL-encoded as `%5C`):
 * - `\@at` → key "@at" (appears as `%5C%40at` in URL)
 * - `\{brace` → key "{brace" (appears as `%5C%7Bbrace` in URL)
 * - `\\backslash` → key "\backslash" (appears as `%5C%5Cbackslash` in URL)
 *
 * ## Parsing Priority (first match wins)
 * 1. Index: `@` + digits
 * 2. Match: `{...}` or URL-encoded `%7B...`
 * 3. Cursors: `[...]`
 * 4. Key: `\...` (escaped, URL-encoded as `%5C...`) or anything else
 */

const URL_PREFIX = "automerge:"
/** The escape character (backslash) */
const ESCAPE_CHAR = "\\"
/** URL-encoded form of the escape character for matching in URLs */
const ESCAPE_PREFIX = "%5C"
const INDEX_PREFIX = "@"
const CURSOR_OPEN = "["
const CURSOR_CLOSE = "]"
const CURSOR_SEPARATOR = "-"

/** Characters that trigger escaping when at the start of a key */
const ESCAPE_TRIGGERS = [ESCAPE_CHAR, INDEX_PREFIX, "{", CURSOR_OPEN]

const INDEX_PATTERN = /^@(\d+)$/

const indexCodec: SegmentCodec<"index"> = {
  kind: "index",
  match: (s) => INDEX_PATTERN.test(s),
  parse: (s) => {
    const m = s.match(INDEX_PATTERN)
    if (!m) throw new Error(`Invalid index: ${s}`)
    return { [KIND]: "index", index: parseInt(m[1], 10) }
  },
  serialize: (seg) => `${INDEX_PREFIX}${seg.index}`,
}

const matchCodec: SegmentCodec<"match"> = {
  kind: "match",
  // Match both raw JSON (backward compat) and URL-encoded JSON
  match: (s) => s.startsWith("{") || s.startsWith("%7B"),
  parse: (s) => {
    try {
      // Decode URL encoding first, then parse JSON
      // This handles both:
      // - New format with URL-encoded JSON (e.g., %7B%22id%22%3A%22test%22%7D)
      // - Old format with raw JSON (e.g., {"id":"test"})
      const decoded = decodeURIComponent(s)
      const parsed = JSON.parse(decoded)
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("Match pattern must be a plain object")
      }
      return { [KIND]: "match", match: parsed }
    } catch (e) {
      throw new Error(
        `Invalid match pattern: ${s}. ${e instanceof Error ? e.message : ""}`
      )
    }
  },
  // URL-encode the JSON to protect slashes and other special characters
  // from being interpreted as path separators
  serialize: (seg) => encodeURIComponent(JSON.stringify(seg.match)),
}

const cursorsCodec: SegmentCodec<"cursors"> = {
  kind: "cursors",
  match: (s) => s.startsWith(CURSOR_OPEN) && s.endsWith(CURSOR_CLOSE),
  parse: (s) => {
    const inner = s.slice(1, -1)
    if (!inner) {
      throw new Error("Invalid cursor range: empty brackets")
    }

    const sepIndex = inner.indexOf(CURSOR_SEPARATOR)
    if (sepIndex === -1) {
      const cursor = inner as Automerge.Cursor
      return { [KIND]: "cursors", start: cursor, end: cursor }
    }

    const start = inner.slice(0, sepIndex) as Automerge.Cursor
    const end = inner.slice(sepIndex + 1) as Automerge.Cursor

    if (!start || !end) {
      throw new Error(
        `Invalid cursor range: ${s}. Expected format: [cursor] or [start-end]`
      )
    }

    return { [KIND]: "cursors", start, end }
  },
  serialize: (seg) => {
    if (seg.start === seg.end) {
      return `${CURSOR_OPEN}${seg.start}${CURSOR_CLOSE}`
    }
    return `${CURSOR_OPEN}${seg.start}${CURSOR_SEPARATOR}${seg.end}${CURSOR_CLOSE}`
  },
}

const keyCodec: SegmentCodec<"key"> = {
  kind: "key",
  match: (s) => {
    // Escaped keys start with backslash (URL-encoded as %5C)
    if (s.startsWith(ESCAPE_PREFIX) || s.startsWith(ESCAPE_CHAR)) {
      return true
    }
    // Regular keys don't start with special prefixes
    // We need to check both raw and URL-decoded forms
    const decoded = safeDecodeURIComponent(s)
    return !ESCAPE_TRIGGERS.some(
      (p) => s.startsWith(p) || decoded.startsWith(p)
    )
  },
  parse: (s) => {
    // Check for URL-encoded escape prefix (%5C) or literal backslash
    if (s.startsWith(ESCAPE_PREFIX)) {
      return {
        [KIND]: "key",
        key: decodeURIComponent(s.slice(ESCAPE_PREFIX.length)),
      }
    }
    if (s.startsWith(ESCAPE_CHAR)) {
      return {
        [KIND]: "key",
        key: decodeURIComponent(s.slice(ESCAPE_CHAR.length)),
      }
    }
    return { [KIND]: "key", key: decodeURIComponent(s) }
  },
  serialize: (seg) => {
    // Check if key starts with any character that needs escaping
    const needsEscape = ESCAPE_TRIGGERS.some((p) => seg.key.startsWith(p))
    const encoded = encodeURIComponent(seg.key)
    // Prefix with URL-encoded backslash (%5C) if escape needed
    return needsEscape ? `${ESCAPE_PREFIX}${encoded}` : encoded
  },
}

/** Safely decode URI component, returning original string on error */
function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * Codecs in priority order. First matching codec wins for parsing.
 * Order: index → match → cursors → key (key is catch-all, must be last)
 */
const SEGMENT_CODECS = [
  indexCodec,
  matchCodec,
  cursorsCodec,
  keyCodec,
] as const

export function parseSegment(segment: string): Segment {
  for (const codec of SEGMENT_CODECS) {
    if (codec.match(segment)) {
      return codec.parse(segment)
    }
  }
  throw new Error(`Invalid segment: "${segment}"`)
}
// ⇧ Parse --- Serialize ⇩
export function serializeSegment(segment: Segment): string {
  for (const codec of SEGMENT_CODECS) {
    if (segment[KIND] === codec.kind) {
      return codec.serialize(segment as any)
    }
  }
  throw new Error(`No codec found for segment kind: ${segment[KIND]}`)
}

export function parsePath(path: string): Segment[] {
  if (!path) return []

  const trimmed = path.replace(/^\/+|\/+$/g, "")
  if (!trimmed) {
    throw new Error(
      "Invalid path: path cannot be empty or consist only of slashes"
    )
  }

  if (trimmed.includes("//")) {
    throw new Error("Invalid path: contains empty segment (double slash)")
  }

  return trimmed.split("/").map(parseSegment)
}
// ⇧ Parse --- Serialize ⇩
export function serializePath(segments: Segment[]): string {
  return segments.map(serializeSegment).join("/")
}

export function parseHeads(heads: string): string[] | undefined {
  return heads ? heads.split("|") : undefined
}
// ⇧ Parse --- Serialize ⇩
export function serializeHeads(heads: string[]): string {
  return heads.length > 0 ? `#${heads.join("|")}` : ""
}

export function parseRefUrl(url: RefUrl): {
  documentId: DocumentId;
  segments: Segment[];
  heads?: string[];
} {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (rest.length > 0) {
    throw new Error("Invalid ref URL: contains multiple heads sections")
  }

  const match = baseUrl.match(/^automerge:([^/]+)(?:\/(.*))?$/)
  if (!match) {
    throw new Error(
      `Invalid ref URL: ${url}\n` +
        `Expected format: automerge:documentId/path/to/value#head1|head2`
    )
  }

  const [, documentId, pathStr] = match

  return {
    documentId: documentId as DocumentId,
    segments: pathStr ? parsePath(pathStr) : [],
    heads: parseHeads(headsSection),
  }
}

// ⇧ Parse --- Serialize ⇩ (named stringify to match other automerge methods)
export function stringifyRefUrl(
  documentId: string,
  segments: Segment[],
  heads?: string[]
): RefUrl {
  const pathStr = serializePath(segments)
  const headsStr = heads ? serializeHeads(heads) : ""
  return `${URL_PREFIX}${documentId}/${pathStr}${headsStr}` as RefUrl
}
