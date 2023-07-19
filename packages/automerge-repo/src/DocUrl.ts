import { DocumentId } from "@automerge/automerge-repo"
import Base58 from "bs58"
import { crc16 } from "js-crc"

export type AutomergeUrl = string & { automerge: true }

export const documentIdFromShareLink = (link: AutomergeUrl) => {
  const { key } = parts(link)

  return key as DocumentId
}

export const isValidShareLink = (str: string): str is AutomergeUrl => {
  const { nonCrc, crc } = parts(str)
  return Boolean(nonCrc) && Boolean(crc) && crc16(nonCrc) === crc
}

export const parts = (str: string) => {
  const p = encodedParts(str)

  return {
    key: p.key && decode(p.key),
    nonCrc: p.nonCrc,
    crc: p.crc && decode(p.crc),
  }
}

export const encodedParts = (str: string) => {
  const [m, nonCrc, key, crc] =
    str.match(/^(automerge:\/\/(\w+))\/(\w{1,4})$/) || []
  return { nonCrc, key, crc }
}

export const withCrc = (str: string) => str + `/` + encode(crc16(str))

export const encode = (str: string) => Base58.encode(hexToBuffer(str))

export const decode = (str: string) => bufferToHex(Base58.decode(str))

export const hexToBuffer = (key: Buffer | string) =>
  Buffer.isBuffer(key) ? key : Buffer.from(key, "hex")

export const bufferToHex = (key: Uint8Array) =>
  Buffer.isBuffer(key) ? key.toString("hex") : key

export const shareLinkForDocumentId = (id: string): string =>
  withCrc("automerge://" + encode(id))
