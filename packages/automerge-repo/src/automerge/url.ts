import bs58check from "bs58check"
import {
  binaryToDocumentId,
  documentIdToBinary,
  toBinaryDocumentId,
} from "../DocumentId.js"
import { uint8ArrayToHexString } from "../sedimentree/hex.js"
import { idBytes, mintDocumentId } from "../sedimentree/ids.js"
import type {
  BinaryDocumentId,
  DocumentId,
  DocumentUrl,
  UrlHeads,
} from "../types.js"
import { parsePath, serializePath } from "./subdoc-handles/parser.js"
import type { Segment } from "./subdoc-handles/types.js"

/**
 * A URL for an Automerge document, in the form `automerge:<base58check encoded
 * string>[/<path>][#<heads>]`; for example,
 * `automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu`.
 */
export type AutomergeUrl = DocumentUrl<"automerge"> // for opening / linking

export const urlPrefix = "automerge:"

const AUTOMERGE_URL = /^automerge:([^/?#]+)(?:\/(.*))?$/

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
   * Optional raw path after the first `/` (without the leading `/`).
   * Undefined for plain document URLs.
   */
  path?: string
  /**
   * Optional path segments, parsed from the `/seg/seg/...` suffix on
   * Automerge URLs that point at a sub-tree of the document. Undefined for
   * plain document URLs.
   */
  segments?: Segment[]
}

export type UrlOptions = {
  documentId: DocumentId | BinaryDocumentId
  heads?: UrlHeads
  /** Raw Automerge URL path (without the leading `/`). Cannot be combined
   * with `segments`. */
  path?: string
  segments?: Segment[]
}

/**
 * Parse an Automerge URL. Throws for any other scheme or malformed path/heads.
 *
 * Supported shapes:
 *   - `automerge:<docId>`
 *   - `automerge:<docId>#<heads>`              (heads `|`-joined)
 *   - `automerge:<docId>/<path>`               (path `/`-joined segments)
 *   - `automerge:<docId>/<path>#<heads>`
 */
export function parseAutomergeUrl(url: AutomergeUrl): ParsedAutomergeUrl {
  const [baseUrl, headsSection, ...rest] = url.split("#")
  if (url.startsWith(urlPrefix) && rest.length > 0) {
    throw new Error("Invalid URL: contains multiple heads sections")
  }
  const match = baseUrl.match(AUTOMERGE_URL)
  if (!match) throw new Error("Invalid Automerge URL: " + url)
  const [, docMatch, pathStr] = match
  const binaryDocumentId = documentIdToBinary(docMatch as DocumentId)
  if (!binaryDocumentId) throw new Error("Invalid Automerge URL: " + url)
  const documentId = binaryToDocumentId(binaryDocumentId)

  const path = pathStr !== undefined && pathStr.length > 0 ? pathStr : undefined
  const segments = path !== undefined ? parsePath(path) : undefined

  const base: ParsedAutomergeUrl = {
    binaryDocumentId,
    documentId,
    ...(path !== undefined ? { path } : {}),
    ...(segments !== undefined ? { segments } : {}),
  }

  if (headsSection === undefined) return base

  const heads = (headsSection === "" ? [] : headsSection.split("|")) as UrlHeads
  const hexHeads = heads.map(head => {
    try {
      return uint8ArrayToHexString(bs58check.decode(head))
    } catch (e) {
      throw new Error(`Invalid head in URL: ${head}`)
    }
  })
  return { ...base, hexHeads, heads }
}

/**
 * Given a documentId in either binary or base58check-encoded form, returns
 * an Automerge URL (`automerge:<docId>`). Optionally accepts `path` or
 * `segments` for a sub-tree URL (`automerge:<docId>/seg/seg/...`) and `heads`
 * to pin the URL to a point in time. Throws on invalid input.
 */
export function stringifyAutomergeUrl(
  arg: UrlOptions | DocumentId | BinaryDocumentId
): AutomergeUrl {
  const {
    documentId,
    heads = undefined,
    path = undefined,
    segments = undefined,
  } = arg instanceof Uint8Array || typeof arg === "string"
    ? { documentId: arg }
    : arg

  const binary = toBinaryDocumentId(documentId)
  if (!binary) throw new Error("Invalid documentId: " + documentId)
  let url: string = `${urlPrefix}${binaryToDocumentId(binary)}`

  const hasPath = path !== undefined && path.length > 0
  const hasSegments = segments !== undefined && segments.length > 0
  if (hasPath && hasSegments)
    throw new Error("Cannot specify both path and segments")
  if (hasPath) {
    if (path.includes("#"))
      throw new Error(`Invalid path: ${JSON.stringify(path)}`)
    parsePath(path)
    url += "/" + path
  } else if (hasSegments) {
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

/** Helper to extract just the heads from an Automerge URL if they exist */
export const getHeadsFromUrl = (url: AutomergeUrl): string[] | undefined => {
  const { heads } = parseAutomergeUrl(url)
  return heads
}

/**
 * Given a string, returns true if it is a valid Automerge URL (`automerge:`
 * scheme, valid document ID, and valid Automerge path and heads if present).
 * Acts as a type discriminator in TypeScript.
 */
export const isValidAutomergeUrl = (str: unknown): str is AutomergeUrl => {
  if (typeof str !== "string" || !str) return false
  try {
    parseAutomergeUrl(str as AutomergeUrl)
    return true
  } catch {
    return false
  }
}

/** Returns a new Automerge URL with a freshly minted document ID. */
export const generateAutomergeUrl = (): AutomergeUrl =>
  stringifyAutomergeUrl({
    documentId: idBytes(mintDocumentId()) as BinaryDocumentId,
  })
