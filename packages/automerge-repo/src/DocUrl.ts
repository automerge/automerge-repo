import { AutomergeUrl, DocumentId, StringDocumentId } from "./types"
import { v4 as uuid } from "uuid"
import Base58 from "bs58check"

export const parseAutomergeUrl = (link: AutomergeUrl) => {
  const { stringDocumentId } = parts(link)
  const documentId = Base58.decodeUnsafe(stringDocumentId) as
    | DocumentId
    | undefined
  if (!documentId) throw new Error("Invalid document URL: " + link)
  return { documentId }
}

interface UrlFromStringIdOptions {
  stringDocumentId: StringDocumentId
  documentId?: never
}
interface UrlFromBinaryIdOptions {
  stringDocumentId?: never
  documentId: DocumentId
}

type GenerateAutomergeUrlOptions =
  | UrlFromStringIdOptions
  | UrlFromBinaryIdOptions

export const generateAutomergeUrl = (
  opts: GenerateAutomergeUrlOptions
): AutomergeUrl => {
  if (opts.stringDocumentId)
    return ("automerge:" + opts.stringDocumentId) as AutomergeUrl
  else if (opts.documentId) {
    return ("automerge:" + encode(opts.documentId)) as AutomergeUrl
  }
  throw new Error("Invalid options: " + opts)
}

export const isValidAutomergeUrl = (str: string): str is AutomergeUrl => {
  const { stringDocumentId } = parts(str)
  const documentId = Base58.decodeUnsafe(stringDocumentId)
  return documentId ? true : false
}

export const parts = (str: string) => {
  const [m, stringDocumentId] = str.match(/^automerge:(\w+)$/) || []
  return { stringDocumentId }
}

export const generate = (): DocumentId =>
  Uint8Array.from(uuid(null, new Uint8Array(16))) as DocumentId

export const encode = (id: DocumentId): StringDocumentId => {
  return Base58.encode(id) as StringDocumentId
}

export const decode = (id: StringDocumentId): DocumentId => {
  const decoded: DocumentId = Base58.decode(id) as DocumentId
  if (decoded.length != 16) throw new Error("Invalid document ID: " + id)
  return decoded
}
