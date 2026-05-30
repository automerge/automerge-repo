import type {
  LegacyDocumentId,
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  AnyDocumentId,
  UrlHeads,
} from "./types.js"

import * as Uuid from "uuid"
import bs58check from "bs58check"
import {
  uint8ArrayFromHexString,
  uint8ArrayToHexString,
} from "./helpers/bufferFromHex.js"
import {
  parsePath,
  serializePath,
} from "./subdoc-handles/parser.js"
import type { Segment } from "./subdoc-handles/types.js"

import type { Heads as AutomergeHeads } from "@automerge/automerge/slim"

export const urlPrefix = "automerge:"

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
  const documentId = docMatch as DocumentId
  const binaryDocumentId = documentIdToBinary(documentId)

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)

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
  if (arg instanceof Uint8Array || typeof arg === "string") {
    return (urlPrefix +
      (arg instanceof Uint8Array
        ? binaryToDocumentId(arg)
        : arg)) as AutomergeUrl
  }

  const { documentId, heads = undefined, segments = undefined } = arg

  if (documentId === undefined)
    throw new Error("Invalid documentId: " + documentId)

  const encodedDocumentId =
    documentId instanceof Uint8Array
      ? binaryToDocumentId(documentId)
      : documentId

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

export const anyDocumentIdToAutomergeUrl = (id: AnyDocumentId) =>
  isValidAutomergeUrl(id)
    ? id
    : isValidDocumentId(id)
      ? stringifyAutomergeUrl({ documentId: id })
      : isValidUuid(id)
        ? parseLegacyUUID(id)
        : undefined

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
  // try to decode from base58
  const binaryDocumentID = documentIdToBinary(str as DocumentId)
  return binaryDocumentID !== undefined
}

export const isValidUuid = (str: unknown): str is LegacyDocumentId =>
  typeof str === "string" && Uuid.validate(str)

/**
 * Returns a new Automerge URL with a random UUID documentId. Called by Repo.create(), and also used by tests.
 */
export const generateAutomergeUrl = (): AutomergeUrl => {
  const documentId = Uuid.v4(undefined, new Uint8Array(16)) as BinaryDocumentId
  return stringifyAutomergeUrl({ documentId })
}

export const documentIdToBinary = (docId: DocumentId) =>
  bs58check.decodeUnsafe(docId) as BinaryDocumentId | undefined

export const binaryToDocumentId = (docId: BinaryDocumentId) =>
  bs58check.encode(docId) as DocumentId

export const encodeHeads = (heads: AutomergeHeads): UrlHeads =>
  heads.map(h => bs58check.encode(uint8ArrayFromHexString(h))) as UrlHeads

export const decodeHeads = (heads: UrlHeads): AutomergeHeads =>
  heads.map(h => uint8ArrayToHexString(bs58check.decode(h))) as AutomergeHeads

export const parseLegacyUUID = (str: string) => {
  if (!Uuid.validate(str)) return undefined
  const documentId = Uuid.parse(str) as BinaryDocumentId
  return stringifyAutomergeUrl({ documentId })
}

/**
 * Given any valid expression of a document ID, returns a DocumentId in base58check-encoded form.
 *
 * Currently supports:
 * - base58check-encoded DocumentId
 * - Automerge URL
 * - legacy UUID
 * - binary DocumentId
 *
 * Throws on invalid input.
 */
export const interpretAsDocumentId = (id: AnyDocumentId) => {
  // binary
  if (id instanceof Uint8Array) return binaryToDocumentId(id)

  // url
  if (isValidAutomergeUrl(id)) return parseAutomergeUrl(id).documentId

  // base58check
  if (isValidDocumentId(id)) return id

  // legacy UUID
  if (isValidUuid(id)) {
    console.warn(
      "Future versions will not support UUIDs as document IDs; use Automerge URLs instead."
    )
    const binaryDocumentID = Uuid.parse(id) as BinaryDocumentId
    return binaryToDocumentId(binaryDocumentID)
  }

  // none of the above
  throw new Error(`Invalid AutomergeUrl: '${id}'`)
}

// TYPES

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  segments?: Segment[]
}
