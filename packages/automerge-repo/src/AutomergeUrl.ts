import {
  type AutomergeUrl,
  type BinaryDocumentId,
  type DocumentId,
} from "./types.js"
import * as Uuid from "uuid"
import bs58check from "bs58check"

export const urlPrefix = "automerge:"

/** Given an Automerge URL, returns the DocumentId in both base58check-encoded form and binary form */
export const parseAutomergeUrl = (url: AutomergeUrl) => {
  const { binaryDocumentId, documentId } = parts(url)
  if (!binaryDocumentId) throw new Error("Invalid document URL: " + url)
  return {
    /** decoded DocumentId */
    binaryDocumentId,
    /** encoded DocumentId */
    documentId,
  }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns an Automerge URL.
 * Throws on invalid input.
 * Note: This function takes an object because we anticipate adding fields in the future.
 */
export const stringifyAutomergeUrl = ({ documentId }: UrlOptions) => {
  if (documentId instanceof Uint8Array)
    return (urlPrefix +
      binaryToDocumentId(documentId as BinaryDocumentId)) as AutomergeUrl
  else if (typeof documentId === "string") {
    return (urlPrefix + documentId) as AutomergeUrl
  }
  throw new Error("Invalid documentId: " + documentId)
}

/**
 * Given a string, returns true if it is a valid Automerge URL. This function also acts as a type
 * discriminator in Typescript.
 */
export const isValidAutomergeUrl = (
  str: string | undefined | null
): str is AutomergeUrl => {
  if (!str || !str.startsWith(urlPrefix)) return false

  const { binaryDocumentId: documentId } = parts(str)
  return documentId ? true : false
}

/**
 * Returns a new Automerge URL with a random UUID documentId. Called by create(), and also used by tests.
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
  const uuid = Uuid.parse(str) as BinaryDocumentId
  return stringifyAutomergeUrl({ documentId: uuid })
}

/**
 * parts breaks up the URL into constituent pieces,
 * eventually this could include things like heads, so we use this structure
 * we return both a binary & string-encoded version of the document ID
 */
const parts = (str: string) => {
  const regex = new RegExp(`^${urlPrefix}(\\w+)$`)
  const [_, docMatch] = str.match(regex) || []
  const documentId = docMatch as DocumentId
  const binaryDocumentId = documentIdToBinary(documentId)
  return {
    /** decoded DocumentId */
    binaryDocumentId,
    /** encoded DocumentId */
    documentId,
  }
}

type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
}
