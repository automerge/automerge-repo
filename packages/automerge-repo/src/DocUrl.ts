import { DocumentUrl, DocumentId, StringDocumentId } from "./types"
import { v4 as uuid } from "uuid"
import Base58 from "bs58check"

export const documentIdFromUrl = (link: DocumentUrl) => {
  const { stringDocumentId } = parts(link)
  const documentId = Base58.decodeUnsafe(stringDocumentId)
  if (!documentId) throw new Error("Invalid document URL: " + link)
  return documentId as DocumentId
}

export const isValidAutomergeUrl = (str: string): str is DocumentUrl => {
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
  if (id.length != 16) {
    console.trace("encode", id)
  }

  return Base58.encode(id) as StringDocumentId
}

export const decode = (id: StringDocumentId): DocumentId => {
  const decoded = Base58.decode(id) as DocumentId
  if (decoded.length != 16) throw new Error("Invalid document ID: " + id)
  return decoded
}

export const urlForDocumentId = (id: DocumentId): DocumentUrl =>
  ("automerge:" + encode(id)) as DocumentUrl
