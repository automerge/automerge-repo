import {
  binaryToDocumentId,
  decodeHeads,
  documentIdToBinary,
  isValidUrlScheme,
  padDocumentId,
  parseUrlScheme,
  splitUrlScheme,
  toBinaryDocumentId,
} from "./DocumentId.js"
import {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  type AutomergeUrl,
} from "./automerge/url.js"
import type {
  AnyDocumentId,
  BinaryDocumentId,
  DocumentId,
  DocumentUrl,
  UrlHeads,
} from "./types.js"

export {
  binaryToDocumentId,
  decodeHeads,
  documentIdToBinary,
  encodeHeads,
  isValidDocumentId,
  isValidUrlScheme,
  parseUrlScheme,
  toBinaryDocumentId,
} from "./DocumentId.js"

const AUTOMERGE = "automerge"

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

export type DocumentUrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  /** The URL scheme (the doc type). Defaults to `"automerge"`. */
  scheme?: string
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
  const parts = splitUrlScheme(url)
  if (!parts) throw new Error("Invalid document URL: " + url)
  const [scheme, body] = parts
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
