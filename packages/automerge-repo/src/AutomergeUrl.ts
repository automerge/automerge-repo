import type {
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  DocumentUrl,
  AnyDocumentId,
  UrlHeads,
} from "./types.js"

import bs58check from "bs58check"
import {
  uint8ArrayFromHexString,
  uint8ArrayToHexString,
} from "./sedimentree/hex.js"
import { parsePath, serializePath } from "./subdoc-handles/parser.js"
import type { Segment } from "./subdoc-handles/types.js"
import { idBytes, mintDocumentId } from "./sedimentree/ids.js"

export const urlPrefix = "automerge:"

const AUTOMERGE = "automerge"
const SCHEME = /^[a-z][a-z0-9+.-]*$/
const URL = /^([a-z][a-z0-9+.-]*):([^/?#]+)([/?#].*)?$/
const SUFFIX_START = /^[/?#]/

/** Lowercase URL schemes, as in RFC 3986: a letter, then letters, digits, `+`, `.` or `-`. */
export const isValidUrlScheme = (scheme: unknown): scheme is string =>
  typeof scheme === "string" && SCHEME.test(scheme)

/**
 * Document IDs are 32 bytes. A 16-byte ID is the short form of one whose
 * second half is zero, so is zero-padded; other lengths are invalid.
 */
const padDocumentId = (
  id: Uint8Array | undefined
): BinaryDocumentId | undefined => {
  if (id?.length === 32) return id as BinaryDocumentId
  if (id?.length !== 16) return undefined
  const padded = new Uint8Array(32)
  padded.set(id)
  return padded as BinaryDocumentId
}

/** Whether an ID's second half is zero. */
const isZeroSuffixed = (id: Uint8Array): boolean =>
  id.length === 32 && id.subarray(16).every(byte => byte === 0)

export interface ParsedDocumentUrl<Scheme extends string = string> {
  /** The URL scheme, naming the document's doc type (e.g. `automerge`). */
  scheme: Scheme
  /** unencoded DocumentId */
  binaryDocumentId: BinaryDocumentId
  /** bs58 encoded DocumentId */
  documentId: DocumentId
  /**
   * Optional doc-type-specific suffix after `<scheme>:<documentId>`, starting
   * with `/`, `?`, or `#`. Undefined for plain document URLs.
   */
  suffix?: string
}

export interface ParsedAutomergeUrl {
  /** unencoded DocumentId */
  binaryDocumentId: BinaryDocumentId
  /** bs58 encoded DocumentId */
  documentId: DocumentId
  /** Optional array of heads, if specified in URL */
  heads?: UrlHeads
  /** Optional hex array of heads, in Automerge core format */
  hexHeads?: string[] // AKA: heads
  /**
   * Optional raw path after the first `/` (without the leading `/`).
   * Undefined for plain document URLs.
   */
  path?: string
  /**
   * Optional path segments, parsed from the `/seg/seg/...` suffix on
   * Automerge URLs that point at a sub-tree of the document. Undefined for
   * plain document URLs.
   */
  segments?: Segment[]
}

/**
 * Parse a document URL of any scheme: `<scheme>:<documentId>[<suffix>]`.
 * Everything after `<documentId>` (starting at `/`, `?`, or `#`) is returned
 * raw in `suffix` for the doc type to interpret.
 */
export function parseDocumentUrl<Scheme extends string>(
  url: DocumentUrl<Scheme>
): ParsedDocumentUrl<Scheme>
export function parseDocumentUrl(url: string): ParsedDocumentUrl
export function parseDocumentUrl(url: string): ParsedDocumentUrl {
  const match = url.match(URL)
  if (!match) throw new Error("Invalid document URL: " + url)
  const [, scheme, docMatch, suffix] = match
  const binaryDocumentId = documentIdToBinary(docMatch as DocumentId)
  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)
  return suffix !== undefined
    ? { scheme, binaryDocumentId, documentId, suffix }
    : { scheme, binaryDocumentId, documentId }
}

/** @internal Parse the Automerge-specific suffix (`[/<path>][#<heads>]`) of an `automerge:` URL. */
export function parseAutomergeSuffix(suffix: string): {
  path?: string
  segments?: Segment[]
  heads?: UrlHeads
  hexHeads?: string[]
} {
  const [pathPart, headsSection, ...rest] = suffix.split("#")
  if (rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  let path: string | undefined
  let segments: Segment[] | undefined
  if (pathPart.length > 0) {
    if (!pathPart.startsWith("/")) {
      throw new Error("Invalid Automerge URL suffix: " + suffix)
    }
    const raw = pathPart.slice(1)
    if (raw.length > 0) {
      path = raw
      segments = parsePath(raw)
    }
  }
  const base = {
    ...(path !== undefined ? { path } : {}),
    ...(segments !== undefined ? { segments } : {}),
  }
  if (headsSection === undefined) return base

  const heads = (headsSection === "" ? [] : headsSection.split("|")) as UrlHeads
  const hexHeads = heads.map(head => {
    try {
      return uint8ArrayToHexString(bs58check.decode(head))
    } catch (e) {
      throw new Error(`Invalid head in URL: ${head}`)
    }
  })
  return { ...base, hexHeads, heads }
}

/**
 * Parse an Automerge URL. Throws for any other scheme or malformed suffix.
 *
 * Supported shapes:
 *   - `automerge:<docId>`
 *   - `automerge:<docId>#<heads>`              (heads `|`-joined)
 *   - `automerge:<docId>/<path>`               (path `/`-joined segments)
 *   - `automerge:<docId>/<path>#<heads>`
 */
export function parseAutomergeUrl(url: AutomergeUrl): ParsedAutomergeUrl {
  if (url.startsWith(urlPrefix) && url.split("#").length > 2) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const { scheme, binaryDocumentId, documentId, suffix } = parseDocumentUrl(url)
  if (scheme !== AUTOMERGE) throw new Error("Invalid Automerge URL: " + url)
  if (suffix === undefined) return { binaryDocumentId, documentId }
  return {
    binaryDocumentId,
    documentId,
    ...parseAutomergeSuffix(suffix),
  }
}

/**
 * Build a document URL: `<scheme>:<documentId>[<suffix>]`. `scheme` defaults
 * to `"automerge"`. `suffix`, when non-empty, must start with `/`, `?`, or `#`.
 * Throws on invalid input.
 */
export function stringifyDocumentUrl<const Scheme extends string>(
  arg: DocumentUrlOptions & { scheme: Scheme }
): DocumentUrl<Scheme>
export function stringifyDocumentUrl(
  arg:
    | (DocumentUrlOptions & { scheme?: undefined })
    | DocumentId
    | BinaryDocumentId
): AutomergeUrl
export function stringifyDocumentUrl(
  arg: DocumentUrlOptions | DocumentId | BinaryDocumentId
): DocumentUrl
export function stringifyDocumentUrl(
  arg: DocumentUrlOptions | DocumentId | BinaryDocumentId
): DocumentUrl {
  const {
    documentId,
    scheme = AUTOMERGE,
    suffix = undefined,
  } = arg instanceof Uint8Array || typeof arg === "string"
    ? { documentId: arg }
    : arg
  if (!isValidUrlScheme(scheme))
    throw new Error(`Invalid URL scheme: ${JSON.stringify(scheme)}`)

  const binary =
    documentId instanceof Uint8Array
      ? padDocumentId(documentId)
      : typeof documentId === "string"
        ? documentIdToBinary(documentId)
        : undefined
  if (!binary) throw new Error("Invalid documentId: " + documentId)
  const encodedDocumentId = binaryToDocumentId(binary)

  if (suffix !== undefined && suffix.length > 0 && !SUFFIX_START.test(suffix))
    throw new Error(
      `Invalid URL suffix (must start with "/", "?", or "#"): ${JSON.stringify(suffix)}`
    )

  return `${scheme}:${encodedDocumentId}${suffix ?? ""}` as DocumentUrl
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns
 * an Automerge URL (`automerge:<docId>`). Optionally accepts `path` or
 * `segments` for a sub-tree URL (`automerge:<docId>/seg/seg/...`) and `heads`
 * to pin the URL to a point in time. Throws on invalid input.
 */
export function stringifyAutomergeUrl(
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl {
  const {
    documentId,
    heads = undefined,
    path = undefined,
    segments = undefined,
  } = arg instanceof Uint8Array || typeof arg === "string"
    ? { documentId: arg }
    : arg

  let suffix = ""
  const hasPath = path !== undefined && path.length > 0
  const hasSegments = segments !== undefined && segments.length > 0
  if (hasPath && hasSegments)
    throw new Error("Cannot specify both path and segments")
  if (hasPath) {
    if (path.includes("#"))
      throw new Error(`Invalid path: ${JSON.stringify(path)}`)
    parsePath(path)
    suffix += "/" + path
  } else if (hasSegments) {
    suffix += "/" + serializePath(segments)
  }

  if (heads !== undefined) {
    heads.forEach(head => {
      try {
        bs58check.decode(head)
      } catch (e) {
        throw new Error(`Invalid head: ${head}`)
      }
    })
    // Sort so two heads arrays with the same content in different
    // orders produce identical URLs.
    suffix += "#" + [...heads].sort().join("|")
  }

  return stringifyDocumentUrl({
    documentId,
    scheme: AUTOMERGE,
    suffix: suffix || undefined,
  })
}

/** Helper to extract just the heads from an Automerge URL if they exist */
export const getHeadsFromUrl = (url: AutomergeUrl): string[] | undefined => {
  const { heads } = parseAutomergeUrl(url)
  return heads
}

/**
 * Whether `str` is a valid document URL (`<scheme>:<documentId>[<suffix>]`),
 * optionally with the given scheme. Suffix syntax is doc-type-specific and
 * not validated here; use {@link isValidAutomergeUrl} for Automerge URLs.
 */
export function isValidDocumentUrl(str: unknown): str is DocumentUrl
export function isValidDocumentUrl<Scheme extends string>(
  str: unknown,
  scheme: Scheme
): str is DocumentUrl<Scheme>
export function isValidDocumentUrl(str: unknown, scheme?: string): boolean {
  if (typeof str !== "string" || !str) return false
  try {
    const parsed = parseDocumentUrl(str)
    return scheme === undefined || parsed.scheme === scheme
  } catch {
    return false
  }
}

/**
 * Given a string, returns true if it is a valid Automerge URL (`automerge:`
 * scheme, valid document ID, and valid Automerge path and heads if present).
 * Acts as a type discriminator in TypeScript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl => {
  if (typeof str !== "string" || !str) return false
  try {
    parseAutomergeUrl(str as AutomergeUrl)
    return true
  } catch {
    return false
  }
}

export const isValidDocumentId = (str: unknown): str is DocumentId =>
  typeof str === "string" && documentIdToBinary(str as DocumentId) !== undefined

/** Returns a new Automerge URL with a freshly minted document ID. */
export const generateAutomergeUrl = (): AutomergeUrl =>
  stringifyAutomergeUrl({
    documentId: idBytes(mintDocumentId()) as BinaryDocumentId,
  })

/**
 * Decodes a base58check-encoded ID to its 32 bytes, padding the short form;
 * undefined if it is not a valid ID.
 */
export const documentIdToBinary = (docId: DocumentId) =>
  padDocumentId(bs58check.decodeUnsafe(docId))

/**
 * Encodes an ID in base58check. An ID whose second half is zero only uses its
 * first 16 bytes.
 */
export const binaryToDocumentId = (docId: BinaryDocumentId) =>
  bs58check.encode(
    isZeroSuffixed(docId) ? docId.subarray(0, 16) : docId
  ) as DocumentId

export const encodeHeads = (heads: readonly string[]): UrlHeads =>
  heads.map(h => bs58check.encode(uint8ArrayFromHexString(h))) as UrlHeads

export const decodeHeads = (heads: UrlHeads): string[] =>
  heads.map(h => uint8ArrayToHexString(bs58check.decode(h)))

/**
 * Given any valid expression of a document ID, returns its DocumentId: the
 * base58check encoding of its 32 bytes, or the first 16 if the rest are zero.
 * 16-byte (v2) IDs are accepted in every form and zero-padded.
 *
 * Currently supports:
 * - base58check-encoded DocumentId
 * - Document URL of any scheme (including Automerge URLs)
 * - binary DocumentId
 *
 * Throws on invalid input.
 */
export const interpretAsDocumentId = (id: AnyDocumentId): DocumentId => {
  // binary
  if (id instanceof Uint8Array) {
    const binary = padDocumentId(id)
    if (binary) return binaryToDocumentId(binary)
    throw new Error("Invalid binary document ID")
  }

  // url
  if (isValidDocumentUrl(id)) return parseDocumentUrl(id).documentId

  // base58check
  const binary = documentIdToBinary(id as DocumentId)
  if (binary) return binaryToDocumentId(binary)

  // none of the above
  throw new Error(`Invalid DocumentUrl: '${id}'`)
}

// TYPES

export type DocumentUrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  /** The URL scheme (the doc type). Defaults to `"automerge"`. */
  scheme?: string
  /** Optional doc-type-specific suffix after `<scheme>:<documentId>`. Must
   * start with `/`, `?`, or `#` if non-empty. */
  suffix?: string
}

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  /** Raw Automerge URL path (without the leading `/`). Cannot be combined
   * with `segments`. */
  path?: string
  segments?: Segment[]
}
