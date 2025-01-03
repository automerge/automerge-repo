import type {
  LegacyDocumentId,
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  AnyDocumentId,
} from "./types.js"
import type { Heads } from "@automerge/automerge/slim"
import * as Uuid from "uuid"
import bs58check from "bs58check"

export const urlPrefix = "automerge:"

interface ParsedAutomergeUrl {
  /** unencoded DocumentId */
  binaryDocumentId: BinaryDocumentId
  /** bs58 encoded DocumentId */
  documentId: DocumentId
  /** Optional array of heads, if specified in URL */
  heads?: Heads
}

/** Given an Automerge URL, returns the DocumentId in both base58check-encoded form and binary form */
export const parseAutomergeUrl = (url: AutomergeUrl): ParsedAutomergeUrl => {
  const [baseUrl, headsSection] = url.split("#")
  const regex = new RegExp(`^${urlPrefix}(\\w+)$`)
  const [, docMatch] = baseUrl.match(regex) || []
  const documentId = docMatch as DocumentId
  const binaryDocumentId = documentIdToBinary(documentId)

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  if (!headsSection) return { binaryDocumentId, documentId }
  const heads = headsSection.split(":").map(head => {
    try {
      bs58check.decode(head)
      return head
    } catch (e) {
      throw new Error(`Invalid head in URL: ${head}`)
    }
  })
  return { binaryDocumentId, documentId, heads }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns an Automerge URL.
 * Throws on invalid input.
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

  const { documentId, heads = [] } = arg

  if (documentId === undefined)
    throw new Error("Invalid documentId: " + documentId)

  const encodedDocumentId =
    documentId instanceof Uint8Array
      ? binaryToDocumentId(documentId)
      : documentId

  let url = `${urlPrefix}${encodedDocumentId}`

  if (heads && heads.length > 0) {
    heads.forEach(head => {
      try {
        bs58check.decode(head)
      } catch (e) {
        throw new Error(`Invalid head: ${head}`)
      }
    })
    url += "#" + heads.join(":")
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
  if (binaryDocumentID === undefined) return false // invalid base58check encoding

  // confirm that the document ID is a valid UUID
  const documentId = Uuid.stringify(binaryDocumentID)
  return Uuid.validate(documentId)
}

export const isValidUuid = (str: unknown): str is LegacyDocumentId =>
  typeof str === "string" && Uuid.validate(str)

/**
 * Returns a new Automerge URL with a random UUID documentId. Called by Repo.create(), and also used by tests.
 */
export const generateAutomergeUrl = (): AutomergeUrl => {
  const documentId = Uuid.v4(null, new Uint8Array(16)) as BinaryDocumentId
  return stringifyAutomergeUrl({ documentId })
}

export const documentIdToBinary = (docId: DocumentId) =>
  bs58check.decodeUnsafe(docId) as BinaryDocumentId | undefined

export const binaryToDocumentId = (docId: BinaryDocumentId) =>
  bs58check.encode(docId) as DocumentId

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

type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: Heads
}
