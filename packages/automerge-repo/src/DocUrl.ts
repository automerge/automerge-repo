import { AutomergeUrl, DocumentId, EncodedDocumentId } from "./types"
import { v4 as uuid } from "uuid"
import bs58check from "bs58check"

export const urlPrefix = "automerge:"

/**
 * given an Automerge URL, return a decoded DocumentId (and the encoded DocumentId)
 *
 * @param url
 * @returns { documentId: Uint8Array(16), encodedDocumentId: bs58check.encode(documentId) }
 */
export const parseAutomergeUrl = (url: AutomergeUrl) => {
  const { documentId, encodedDocumentId } = parts(url)
  if (!documentId) throw new Error("Invalid document URL: " + url)
  return { documentId, encodedDocumentId }
}

interface StringifyAutomergeUrlOptions {
  documentId: EncodedDocumentId | DocumentId
}

/**
 * Given a documentId in either canonical form, return an Automerge URL
 * Throws on invalid input.
 * Note: this is an object because we anticipate adding fields in the future.
 * @param { documentId: EncodedDocumentId | DocumentId }
 * @returns AutomergeUrl
 */
export const stringifyAutomergeUrl = ({
  documentId,
}: StringifyAutomergeUrlOptions): AutomergeUrl => {
  if (documentId instanceof Uint8Array)
    return (urlPrefix +
      encodeDocumentId(documentId as DocumentId)) as AutomergeUrl
  else if (typeof documentId === "string") {
    return (urlPrefix + documentId) as AutomergeUrl
  }
  throw new Error("Invalid documentId: " + documentId)
}

/**
 * Given a string, return true if it is a valid Automerge URL
 * also acts as a type discriminator in Typescript.
 * @param str: URL candidate
 * @returns boolean
 */
export const isValidAutomergeUrl = (str: string): str is AutomergeUrl => {
  if (!str.startsWith(urlPrefix)) return false

  const { documentId } = parts(str)
  return documentId ? true : false
}

/**
 * generateAutomergeUrl produces a new AutomergeUrl.
 * generally only called by create(), but used in tests as well.
 * @returns a new Automerge URL with a random UUID documentId
 */
export const generateAutomergeUrl = (): AutomergeUrl =>
  stringifyAutomergeUrl({
    documentId: uuid(null, new Uint8Array(16)) as DocumentId,
  })

export const decodeDocumentId = (
  docId: EncodedDocumentId
): DocumentId | undefined =>
  bs58check.decodeUnsafe(docId) as DocumentId | undefined

export const encodeDocumentId = (docId: DocumentId): EncodedDocumentId =>
  bs58check.encode(docId) as EncodedDocumentId

/**
 * parts breaks up the URL into constituent pieces,
 * eventually this could include things like heads, so we use this structure
 * @param str
 * @returns
 */
const parts = (str: string) => {
  const regex = new RegExp(`^${urlPrefix}(\\w+)$`)
  const [m, docMatch] = str.match(regex) || []
  const encodedDocumentId = docMatch as EncodedDocumentId
  const documentId = decodeDocumentId(encodedDocumentId)
  return { documentId, encodedDocumentId }
}
