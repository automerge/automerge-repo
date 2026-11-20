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

import type { Heads as AutomergeHeads } from "@automerge/automerge/slim"

export const urlPrefix = "automerge:"

const SCHEME = /^[a-z][a-z0-9+.-]*$/
const URL = /^([a-z][a-z0-9+.-]*):([^/]+)(?:\/(.*))?$/

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
   * Optional path segments, parsed from the `/seg/seg/...` suffix on
   * URLs that point at a sub-tree of the document. Undefined for plain
   * document URLs.
   */
  segments?: Segment[]
}

export interface ParsedDocumentUrl<
  Scheme extends string = string,
> extends ParsedAutomergeUrl {
  scheme: Scheme
}

/**
 * Parse a document URL with any valid scheme.
 *
 * Supported shapes:
 *   - `<scheme>:<docId>`
 *   - `<scheme>:<docId>#<heads>`              (heads `|`-joined)
 *   - `<scheme>:<docId>/<path>`               (path `/`-joined segments)
 *   - `<scheme>:<docId>/<path>#<heads>`
 *
 * `segments` is undefined when no path is present; otherwise it's the
 * parsed `Segment[]`.
 */
export function parseDocumentUrl<Scheme extends string>(
  url: DocumentUrl<Scheme>
): ParsedDocumentUrl<Scheme>
export function parseDocumentUrl(url: string): ParsedDocumentUrl
export function parseDocumentUrl(url: string): ParsedDocumentUrl {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const match = baseUrl.match(URL)
  if (!match) throw new Error("Invalid document URL: " + url)
  const [, scheme, docMatch, pathStr] = match
  const binaryDocumentId = documentIdToBinary(docMatch as DocumentId)

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)

  const segments =
    pathStr !== undefined && pathStr.length > 0 ? parsePath(pathStr) : undefined

  if (headsSection === undefined) {
    return segments
      ? { scheme, binaryDocumentId, documentId, segments }
      : { scheme, binaryDocumentId, documentId }
  }

  const heads = (headsSection === "" ? [] : headsSection.split("|")) as UrlHeads
  const hexHeads = heads.map(head => {
    try {
      return uint8ArrayToHexString(bs58check.decode(head))
    } catch (e) {
      throw new Error(`Invalid head in URL: ${head}`)
    }
  })
  return segments
    ? { scheme, binaryDocumentId, hexHeads, documentId, heads, segments }
    : { scheme, binaryDocumentId, hexHeads, documentId, heads }
}

/** Parse an Automerge URL; throws for any other scheme. */
export const parseAutomergeUrl = (url: AutomergeUrl): ParsedAutomergeUrl => {
  const { scheme, ...parsed } = parseDocumentUrl(url)
  if (scheme !== "automerge") throw new Error("Invalid Automerge URL: " + url)
  return parsed
}

/**
 * A document URL with the given scheme (`automerge` by default). Optionally
 * accepts `segments` for a sub-tree URL (`<scheme>:<docId>/seg/seg/...`) and
 * `heads` to pin it to a point in time. Throws on invalid input.
 */
export function stringifyDocumentUrl<Scheme extends string>(
  options: UrlOptions & { scheme: Scheme }
): DocumentUrl<Scheme>
export function stringifyDocumentUrl(
  options: UrlOptions & { scheme?: undefined }
): AutomergeUrl
export function stringifyDocumentUrl(options: UrlOptions): DocumentUrl
export function stringifyDocumentUrl({
  documentId,
  heads = undefined,
  segments = undefined,
  scheme = "automerge",
}: UrlOptions): DocumentUrl {
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

  let url = `${scheme}:${encodedDocumentId}`

  if (segments !== undefined && segments.length > 0) {
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

  return url as DocumentUrl
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns
 * an Automerge URL. Optionally accepts `segments` to construct a sub-tree
 * URL (`automerge:<docId>/seg/seg/...`) and `heads` to pin the URL to a
 * point in time. Throws on invalid input.
 */
export const stringifyAutomergeUrl = (
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl =>
  stringifyDocumentUrl({
    ...(arg instanceof Uint8Array || typeof arg === "string"
      ? { documentId: arg }
      : arg),
    scheme: "automerge",
  })

/** Helper to extract just the heads from a URL if they exist */
export const getHeadsFromUrl = (url: DocumentUrl): string[] | undefined => {
  const { heads } = parseDocumentUrl(url)
  return heads
}

/**
 * Given a string, returns true if it is a valid Automerge URL. This function also acts as a type
 * discriminator in Typescript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl =>
  isValidDocumentUrl(str, "automerge")

/** Whether `str` is a valid document URL, optionally with the given scheme. */
export function isValidDocumentUrl(str: unknown): str is DocumentUrl
export function isValidDocumentUrl<Scheme extends string>(
  str: unknown,
  scheme: Scheme
): str is DocumentUrl<Scheme>
export function isValidDocumentUrl(str: unknown, scheme?: string): boolean {
  if (typeof str !== "string" || !str) return false
  try {
    // Parsing validates the ID and heads.
    const parsed = parseDocumentUrl(str)
    return scheme === undefined || parsed.scheme === scheme
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

export const encodeHeads = (heads: AutomergeHeads): UrlHeads =>
  heads.map(h => bs58check.encode(uint8ArrayFromHexString(h))) as UrlHeads

export const decodeHeads = (heads: UrlHeads): AutomergeHeads =>
  heads.map(h => uint8ArrayToHexString(bs58check.decode(h))) as AutomergeHeads

/**
 * Given any valid expression of a document ID, returns its DocumentId: the
 * base58check encoding of its 32 bytes, or the first 16 if the rest are zero.
 * 16-byte (v2) IDs are accepted in every form and zero-padded.
 *
 * Currently supports:
 * - base58check-encoded DocumentId
 * - Automerge URL
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
  throw new Error(`Invalid AutomergeUrl: '${id}'`)
}

// TYPES

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  segments?: Segment[]
  /** Defaults to `automerge`. */
  scheme?: string
}
