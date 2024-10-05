import type {
  LegacyDocumentId,
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  AnyDocumentId,
} from "./types.js"
import * as Uuid from "uuid"
import bs58check from "bs58check"

export const urlPrefix = "automerge:"

/** Given an Automerge URL, returns the DocumentId in both base58check-encoded form and binary form */
export const parseAutomergeUrl = (url: AutomergeUrl) => {
  const regex = new RegExp(`^${urlPrefix}(\\w+)$`)
  const [, docMatch] = url.match(regex) || []
  const documentId = docMatch as DocumentId
  const binaryDocumentId = documentIdToBinary(documentId)

  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  return {
    /** unencoded DocumentId */
    binaryDocumentId,
    /** encoded DocumentId */
    documentId,
  }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns an Automerge URL.
 * Throws on invalid input.
 */
export const stringifyAutomergeUrl = (
  arg: UrlOptions | DocumentId | BinaryDocumentId
) => {
  const documentId =
    arg instanceof Uint8Array || typeof arg === "string"
      ? arg
      : "documentId" in arg
      ? arg.documentId
      : undefined

  const encodedDocumentId =
    documentId instanceof Uint8Array
      ? binaryToDocumentId(documentId)
      : typeof documentId === "string"
      ? documentId
      : undefined

  if (encodedDocumentId === undefined)
    throw new Error("Invalid documentId: " + documentId)

  return (urlPrefix + encodedDocumentId) as AutomergeUrl
}

/**
 * Given a string, returns true if it is a valid Automerge URL. This function also acts as a type
 * discriminator in Typescript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl => {
  if (typeof str !== "string") return false
  if (!str || !str.startsWith(urlPrefix)) return false
  const automergeUrl = str as AutomergeUrl
  try {
    const { documentId } = parseAutomergeUrl(automergeUrl)
    return isValidDocumentId(documentId)
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
  throw new InvalidAutomergeUrlError(`Invalid AutomergeUrl: '${id}'`)
}

export class InvalidAutomergeUrlError extends Error {
  constructor(message: string) {
    super(message)
    // https://github.com/microsoft/TypeScript/wiki/FAQ#why-doesnt-extending-built-ins-like-error-array-and-map-work
    Object.setPrototypeOf(this, InvalidAutomergeUrlError.prototype)
  }
}

// TYPES

type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
}
