import bs58check from "bs58check"
import {
  uint8ArrayFromHexString,
  uint8ArrayToHexString,
} from "./sedimentree/hex.js"
import type { BinaryDocumentId, DocumentId, UrlHeads } from "./types.js"

const SCHEME = /^[a-z][a-z0-9+.-]*$/
const SCHEME_PREFIX = /^([a-z][a-z0-9+.-]*):(.+)$/

/** Valid URL scheme: a lowercase letter followed by lowercase letters, digits, `+`, `.` or `-`. */
export const isValidUrlScheme = (scheme: unknown): scheme is string =>
  typeof scheme === "string" && SCHEME.test(scheme)

/** @internal Split `<scheme>:<nonempty>` into `[scheme, body]`, or `undefined`. */
export const splitUrlScheme = (
  url: unknown
): [scheme: string, body: string] | undefined => {
  if (typeof url !== "string") return undefined
  const match = url.match(SCHEME_PREFIX)
  return match ? [match[1], match[2]] : undefined
}

/**
 * Extract the URL scheme from any `<scheme>:<nonempty>` string, or
 * `undefined` if it does not begin with a valid scheme (see {@link isValidUrlScheme}).
 * Works regardless of the doc type's URL format after `<scheme>:`.
 */
export const parseUrlScheme = (url: unknown): string | undefined =>
  splitUrlScheme(url)?.[0]

/**
 * Document IDs are 32 bytes. A 16-byte ID is the short form of one whose
 * second half is zero, so is zero-padded; other lengths are invalid.
 */
export const padDocumentId = (
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

export const isValidDocumentId = (str: unknown): str is DocumentId =>
  typeof str === "string" && documentIdToBinary(str as DocumentId) !== undefined

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
