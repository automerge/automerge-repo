import { AutomergeUrl, DocumentId, StringDocumentId } from "./types"
import { v4 as uuid } from "uuid"
import bs58check from "bs58check"

export const parseAutomergeUrl = (link: AutomergeUrl) => {
  const { stringDocumentId } = parts(link)
  const documentId = bs58check.decodeUnsafe(stringDocumentId) as
    | DocumentId
    | undefined
  if (!documentId) throw new Error("Invalid document URL: " + link)
  return { documentId }
}

interface GenerateAutomergeUrlOptions {
  documentId: StringDocumentId | DocumentId
}

export const generateAutomergeUrl = ({
  documentId,
}: GenerateAutomergeUrlOptions): AutomergeUrl => {
  if (documentId instanceof Uint8Array)
    return ("automerge:" + bs58check.encode(documentId)) as AutomergeUrl
  else if (typeof documentId === "string") {
    return ("automerge:" + documentId) as AutomergeUrl
  }
  throw new Error("Invalid documentId: " + documentId)
}

export const isValidAutomergeUrl = (str: string): str is AutomergeUrl => {
  const { stringDocumentId } = parts(str)
  const documentId = bs58check.decodeUnsafe(stringDocumentId)
  return documentId ? true : false
}

export const parts = (str: string) => {
  const [m, stringDocumentId] = str.match(/^automerge:(\w+)$/) || []
  return { stringDocumentId }
}

export const generate = (): DocumentId =>
  Uint8Array.from(uuid(null, new Uint8Array(16))) as DocumentId

export const encode = (id: DocumentId): StringDocumentId => {
  return bs58check.encode(id) as StringDocumentId
}

export const decode = (id: StringDocumentId): DocumentId => {
  const decoded: DocumentId = bs58check.decode(id) as DocumentId
  if (decoded.length != 16) throw new Error("Invalid document ID: " + id)
  return decoded
}
