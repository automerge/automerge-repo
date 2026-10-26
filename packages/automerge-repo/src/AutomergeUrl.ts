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
} from "./helpers/bufferFromHex.js"
import { parsePath, serializePath } from "./subdoc-handles/parser.js"
import type { Segment } from "./subdoc-handles/types.js"
import { idBytes, mintDocumentId } from "./sedimentree/ids.js"

import type { Heads as AutomergeHeads } from "@automerge/automerge/slim"

export const urlPrefix = "automerge:"

/**
 * Document IDs are 32 bytes. Legacy 16-byte IDs are accepted wherever an ID is
 * and normalized to their 32-byte equivalent; other lengths are invalid.
 */
const normalizeDocumentId = (
  id: Uint8Array | undefined
): BinaryDocumentId | undefined => {
  if (id?.length === 32) return id as BinaryDocumentId
  if (id?.length !== 16) return undefined
  const normalized = new Uint8Array(32)
  normalized.set(id)
  return normalized as BinaryDocumentId
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
   * Optional path segments, parsed from the `/seg/seg/...` suffix on
   * URLs that point at a sub-tree of the document. Undefined for plain
   * document URLs.
   */
  segments?: Segment[]
}

/**
 * Parse an Automerge URL.
 *
 * Supported shapes:
 *   - `automerge:<docId>`
 *   - `automerge:<docId>#<heads>`              (heads `|`-joined)
 *   - `automerge:<docId>/<path>`               (path `/`-joined segments)
 *   - `automerge:<docId>/<path>#<heads>`
 *
 * `segments` is undefined when no path is present; otherwise it's the
 * parsed `Segment[]`.
 */
export const parseAutomergeUrl = (url: AutomergeUrl): ParsedAutomergeUrl => {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const match = baseUrl.match(new RegExp(`^${urlPrefix}([^/]+)(?:\\/(.*))?$`))
  if (!match) throw new Error("Invalid document URL: " + url)
  const [, docMatch, pathStr] = match
  const binaryDocumentId = normalizeDocumentId(
    documentIdToBinary(docMatch as DocumentId)
  )

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)

  const segments =
    pathStr !== undefined && pathStr.length > 0 ? parsePath(pathStr) : undefined

  if (headsSection === undefined) {
    return segments
      ? { binaryDocumentId, documentId, segments }
      : { binaryDocumentId, documentId }
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
    ? { binaryDocumentId, hexHeads, documentId, heads, segments }
    : { binaryDocumentId, hexHeads, documentId, heads }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns
 * an Automerge URL. Optionally accepts `segments` to construct a sub-tree
 * URL (`automerge:<docId>/seg/seg/...`) and `heads` to pin the URL to a
 * point in time. Throws on invalid input.
 */
export const stringifyAutomergeUrl = (
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl => {
  const {
    documentId,
    heads = undefined,
    segments = undefined,
  } = arg instanceof Uint8Array || typeof arg === "string"
    ? { documentId: arg }
    : arg

  const binary = normalizeDocumentId(
    documentId instanceof Uint8Array
      ? documentId
      : typeof documentId === "string"
        ? documentIdToBinary(documentId)
        : undefined
  )
  if (!binary) throw new Error("Invalid documentId: " + documentId)
  const encodedDocumentId = binaryToDocumentId(binary)

  let url = `${urlPrefix}${encodedDocumentId}`

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
 * Given a string, returns true if it is a valid Automerge URL. This function also acts as a type
 * discriminator in Typescript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl => {
  if (typeof str !== "string" || !str || !str.startsWith(urlPrefix))
    return false
  try {
    const { documentId, heads } = parseAutomergeUrl(str as AutomergeUrl)
    if (!isValidDocumentId(documentId)) return false
    if (
      heads &&
      !heads.every(head => {
        try {
          bs58check.decode(head)
          return true
        } catch {
          return false
        }
      })
    )
      return false
    return true
  } catch {
    return false
  }
}

export const isValidDocumentId = (str: unknown): str is DocumentId => {
  if (typeof str !== "string") return false
  return (
    normalizeDocumentId(documentIdToBinary(str as DocumentId)) !== undefined
  )
}

/** Returns a new Automerge URL with a freshly minted document ID. */
export const generateAutomergeUrl = (): AutomergeUrl =>
  stringifyAutomergeUrl({
    documentId: idBytes(mintDocumentId()) as BinaryDocumentId,
  })

export const documentIdToBinary = (docId: DocumentId) =>
  bs58check.decodeUnsafe(docId) as BinaryDocumentId | undefined

export const binaryToDocumentId = (docId: BinaryDocumentId) =>
  bs58check.encode(docId) as DocumentId

export const encodeHeads = (heads: AutomergeHeads): UrlHeads =>
  heads.map(h => bs58check.encode(uint8ArrayFromHexString(h))) as UrlHeads

export const decodeHeads = (heads: UrlHeads): AutomergeHeads =>
  heads.map(h => uint8ArrayToHexString(bs58check.decode(h))) as AutomergeHeads

/**
 * Given any valid expression of a document ID, returns its 32-byte DocumentId
 * in base58check-encoded form.
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
    const binary = normalizeDocumentId(id)
    if (binary) return binaryToDocumentId(binary)
    throw new Error("Invalid binary document ID")
  }

  // url
  if (isValidAutomergeUrl(id)) return parseAutomergeUrl(id).documentId

  // base58check
  const binary = normalizeDocumentId(documentIdToBinary(id as DocumentId))
  if (binary) return binaryToDocumentId(binary)

  // none of the above
  throw new Error(`Invalid AutomergeUrl: '${id}'`)
}

// TYPES

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  segments?: Segment[]
}
