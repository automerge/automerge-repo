import type {
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
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

/** The doc type every URL without a doc type name is for. */
const AUTOMERGE = "automerge"
const NAME = /^[a-z][a-z0-9-]*$/
const URL = /^automerge:(?:([a-z][a-z0-9-]*):)?([^/:]+)(?:\/(.*))?$/

/** Doc type names: a lowercase letter, then lowercase letters, digits or `-`.
 * `automerge` is Automerge's, and is never written in URLs. */
export const isValidDocTypeName = (name: unknown): name is string =>
  typeof name === "string" && NAME.test(name)

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

export interface ParsedAutomergeUrl<DocTypeName extends string = string> {
  /** The name of the document's doc type: `automerge` unless the URL names
   * another, as in `automerge:<name>:<docId>`. */
  docTypeName: DocTypeName
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

/**
 * Parse a document URL.
 *
 * Supported shapes:
 *   - `automerge:<docId>`                      (an Automerge document)
 *   - `automerge:<name>:<docId>`               (a document of doc type `name`)
 *   - either, then `/<path>` (`/`-joined segments) and/or `#<heads>`
 *     (`|`-joined)
 *
 * `segments` is undefined when no path is present; otherwise it's the
 * parsed `Segment[]`.
 */
export function parseAutomergeUrl<DocTypeName extends string>(
  url: AutomergeUrl<DocTypeName>
): ParsedAutomergeUrl<DocTypeName>
export function parseAutomergeUrl(url: AutomergeUrl): ParsedAutomergeUrl {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const match = baseUrl.match(URL)
  // Automerge's name is never written, so each document has one URL.
  if (!match || match[1] === AUTOMERGE)
    throw new Error("Invalid document URL: " + url)
  const [, docTypeName = AUTOMERGE, docMatch, pathStr] = match
  const binaryDocumentId = documentIdToBinary(docMatch as DocumentId)

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)

  const segments =
    pathStr !== undefined && pathStr.length > 0 ? parsePath(pathStr) : undefined

  if (headsSection === undefined) {
    return segments
      ? { docTypeName, binaryDocumentId, documentId, segments }
      : { docTypeName, binaryDocumentId, documentId }
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
    ? { docTypeName, binaryDocumentId, hexHeads, documentId, heads, segments }
    : { docTypeName, binaryDocumentId, hexHeads, documentId, heads }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns
 * its URL: an Automerge document's, or with `docType`, one of that type
 * (`automerge:<name>:<docId>`). Optionally accepts `segments` to construct a
 * sub-tree URL (`automerge:<docId>/seg/seg/...`) and `heads` to pin the URL
 * to a point in time. Throws on invalid input.
 */
export function stringifyAutomergeUrl<const DocTypeName extends string>(
  arg: UrlOptions & { docType: { readonly name: DocTypeName } }
): AutomergeUrl<DocTypeName>
export function stringifyAutomergeUrl(
  arg: (UrlOptions & { docType?: undefined }) | DocumentId | BinaryDocumentId
): AutomergeUrl<"automerge">
export function stringifyAutomergeUrl(
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl
export function stringifyAutomergeUrl(
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl {
  const {
    documentId,
    heads = undefined,
    segments = undefined,
    docType = undefined,
  } = arg instanceof Uint8Array || typeof arg === "string"
    ? { documentId: arg }
    : arg
  const name = docType?.name ?? AUTOMERGE
  if (!isValidDocTypeName(name))
    throw new Error(`Invalid doc type name: ${JSON.stringify(name)}`)

  const binary =
    documentId instanceof Uint8Array
      ? padDocumentId(documentId)
      : typeof documentId === "string"
        ? documentIdToBinary(documentId)
        : undefined
  if (!binary) throw new Error("Invalid documentId: " + documentId)
  const encodedDocumentId = binaryToDocumentId(binary)

  let url =
    name === AUTOMERGE
      ? `${urlPrefix}${encodedDocumentId}`
      : `${urlPrefix}${name}:${encodedDocumentId}`

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

  return url as AutomergeUrl
}

/** Helper to extract just the heads from a URL if they exist */
export const getHeadsFromUrl = (url: AutomergeUrl): string[] | undefined => {
  const { heads } = parseAutomergeUrl(url)
  return heads
}

/**
 * Given a string, returns true if it is a valid document URL, of any doc
 * type: this checks the URL's format only. This function also acts as a type
 * discriminator in Typescript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl => {
  if (typeof str !== "string" || !str) return false
  try {
    // Parsing validates the ID and heads.
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
  if (isValidAutomergeUrl(id)) return parseAutomergeUrl(id).documentId

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
  /** The document's doc type; its name is written in the URL unless it is
   * Automerge. Defaults to Automerge. */
  docType?: { readonly name: string }
}
