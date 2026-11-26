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
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):(.+)$/
const AUTOMERGE_URL = /^automerge:([^/?#]+)(?:\/(.*))?$/

/** Valid URL scheme: a lowercase letter followed by lowercase letters, digits, `+`, `.` or `-`. */
export const isValidUrlScheme = (scheme: unknown): scheme is string =>
  typeof scheme === "string" && SCHEME.test(scheme)

/**
 * Extract the URL scheme from any `<scheme>:<nonempty>` string, or
 * `undefined` if it does not begin with a valid scheme (see {@link isValidUrlScheme}).
 * Works regardless of the doc type's URL format after `<scheme>:`.
 */
export const parseUrlScheme = (url: unknown): string | undefined =>
  typeof url === "string" ? url.match(SCHEME_PREFIX)?.[1] : undefined

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

/** @internal Decode a binary or base58check document ID to its 32 bytes. */
export const toBinaryDocumentId = (
  documentId: unknown
): BinaryDocumentId | undefined =>
  documentId instanceof Uint8Array
    ? padDocumentId(documentId)
    : typeof documentId === "string"
      ? documentIdToBinary(documentId as DocumentId)
      : undefined

/** Whether an ID's second half is zero. */
const isZeroSuffixed = (id: Uint8Array): boolean =>
  id.length === 32 && id.subarray(16).every(byte => byte === 0)

/** The subset of a doc type needed to parse or validate its URLs. */
export type UrlDocType<Scheme extends string = string> = {
  readonly scheme: Scheme
  openUrl?(url: string): {
    readonly documentId: DocumentId | BinaryDocumentId
    readonly heads?: UrlHeads
  }
}

export interface ParsedDocumentUrl<Scheme extends string = string> {
  /** The URL scheme, naming the document's doc type (e.g. `automerge`). */
  scheme: Scheme
  /** unencoded DocumentId */
  binaryDocumentId: BinaryDocumentId
  /** bs58 encoded DocumentId */
  documentId: DocumentId
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
 * Parse a document URL. Without `docType`, parses the default
 * `<scheme>:<base58DocumentId>` format. With `docType`, verifies the scheme
 * matches and delegates to `docType.openUrl` if defined (or the default
 * format otherwise).
 */
export function parseDocumentUrl<const Scheme extends string>(
  url: string,
  docType: UrlDocType<Scheme>
): ParsedDocumentUrl<Scheme>
export function parseDocumentUrl<Scheme extends string>(
  url: DocumentUrl<Scheme>
): ParsedDocumentUrl<Scheme>
export function parseDocumentUrl(url: string): ParsedDocumentUrl
export function parseDocumentUrl(
  url: string,
  docType?: UrlDocType
): ParsedDocumentUrl {
  const match = url.match(SCHEME_PREFIX)
  if (!match) throw new Error("Invalid document URL: " + url)
  const [, scheme, body] = match
  if (docType !== undefined) {
    if (scheme !== docType.scheme)
      throw new Error(`Invalid ${docType.scheme} URL: ${url}`)
    if (docType.openUrl) {
      const target = docType.openUrl(url)
      const binaryDocumentId = toBinaryDocumentId(target.documentId)
      if (!binaryDocumentId)
        throw new Error(`Invalid ${docType.scheme} URL: ${url}`)
      if (target.heads !== undefined) decodeHeads(target.heads)
      return {
        scheme,
        binaryDocumentId,
        documentId: binaryToDocumentId(binaryDocumentId),
      }
    }
  }
  const binaryDocumentId = documentIdToBinary(body as DocumentId)
  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  return {
    scheme,
    binaryDocumentId,
    documentId: binaryToDocumentId(binaryDocumentId),
  }
}

/**
 * Parse an Automerge URL. Throws for any other scheme or malformed path/heads.
 *
 * Supported shapes:
 *   - `automerge:<docId>`
 *   - `automerge:<docId>#<heads>`              (heads `|`-joined)
 *   - `automerge:<docId>/<path>`               (path `/`-joined segments)
 *   - `automerge:<docId>/<path>#<heads>`
 */
export function parseAutomergeUrl(url: AutomergeUrl): ParsedAutomergeUrl {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (url.startsWith(urlPrefix) && rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const match = baseUrl.match(AUTOMERGE_URL)
  if (!match) throw new Error("Invalid Automerge URL: " + url)
  const [, docMatch, pathStr] = match
  const binaryDocumentId = documentIdToBinary(docMatch as DocumentId)
  if (!binaryDocumentId) throw new Error("Invalid Automerge URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)

  const path = pathStr !== undefined && pathStr.length > 0 ? pathStr : undefined
  const segments = path !== undefined ? parsePath(path) : undefined

  const base: ParsedAutomergeUrl = {
    binaryDocumentId,
    documentId,
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
 * Build a default document URL: `<scheme>:<documentId>`. `scheme` defaults to
 * `"automerge"`. Doc types with custom URL formats build their own URLs (see
 * {@link stringifyAutomergeUrl} for Automerge). Throws on invalid input.
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
  const { documentId, scheme = AUTOMERGE } =
    arg instanceof Uint8Array || typeof arg === "string"
      ? { documentId: arg }
      : arg
  if (!isValidUrlScheme(scheme))
    throw new Error(`Invalid URL scheme: ${JSON.stringify(scheme)}`)

  const binary = toBinaryDocumentId(documentId)
  if (!binary) throw new Error("Invalid documentId: " + documentId)
  const encodedDocumentId = binaryToDocumentId(binary)

  return `${scheme}:${encodedDocumentId}` as DocumentUrl
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

  let url: string = stringifyDocumentUrl({ documentId, scheme: AUTOMERGE })

  const hasPath = path !== undefined && path.length > 0
  const hasSegments = segments !== undefined && segments.length > 0
  if (hasPath && hasSegments)
    throw new Error("Cannot specify both path and segments")
  if (hasPath) {
    if (path.includes("#"))
      throw new Error(`Invalid path: ${JSON.stringify(path)}`)
    parsePath(path)
    url += "/" + path
  } else if (hasSegments) {
    url += "/" + serializePath(segments)
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
    url += "#" + [...heads].sort().join("|")
  }

  return url as AutomergeUrl
}

/** Helper to extract just the heads from an Automerge URL if they exist */
export const getHeadsFromUrl = (url: AutomergeUrl): string[] | undefined => {
  const { heads } = parseAutomergeUrl(url)
  return heads
}

/**
 * Whether `str` is a valid document URL.
 * - With no second argument: validates the default `<scheme>:<base58DocumentId>` format.
 * - With a scheme string: validates the default format with that scheme.
 * - With a doc type: validates the scheme and delegates to `docType.openUrl`
 *   if defined (or the default format otherwise).
 */
export function isValidDocumentUrl(str: unknown): str is DocumentUrl
export function isValidDocumentUrl<const Scheme extends string>(
  str: unknown,
  schemeOrDocType: Scheme | UrlDocType<Scheme>
): str is DocumentUrl<Scheme>
export function isValidDocumentUrl(
  str: unknown,
  schemeOrDocType?: string | UrlDocType
): boolean {
  if (typeof str !== "string" || !str) return false
  try {
    if (typeof schemeOrDocType === "object" && schemeOrDocType !== null) {
      parseDocumentUrl(str, schemeOrDocType)
      return true
    }
    const parsed = parseDocumentUrl(str)
    return schemeOrDocType === undefined || parsed.scheme === schemeOrDocType
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
 * - Automerge URL (including `/path` and `#heads`)
 * - Default `<scheme>:<base58DocumentId>` URL of any scheme
 * - Any custom URL format when `docType` is passed
 * - binary DocumentId
 *
 * Throws on invalid input.
 */
export const interpretAsDocumentId = (
  id: AnyDocumentId,
  docType?: UrlDocType
): DocumentId => {
  // binary
  if (id instanceof Uint8Array) {
    const binary = padDocumentId(id)
    if (binary) return binaryToDocumentId(binary)
    throw new Error("Invalid binary document ID")
  }

  // url with explicit docType
  if (docType !== undefined && parseUrlScheme(id) !== undefined) {
    return parseDocumentUrl(id, docType).documentId
  }

  // Automerge URL (including /path and #heads)
  if (isValidAutomergeUrl(id)) return parseAutomergeUrl(id).documentId

  // default <scheme>:<base58DocumentId> URL
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
}

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  /** Raw Automerge URL path (without the leading `/`). Cannot be combined
   * with `segments`. */
  path?: string
  segments?: Segment[]
}
