import { Heads } from "@automerge/automerge"
import {
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  UrlHeads,
} from "./types.js"
import {
  decodeHeads,
  documentIdToBinary,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
import { DocHandle } from "./DocHandle.js"
import { next as Automerge } from "@automerge/automerge"
import { binaryToDocumentId } from "./AutomergeUrl.js"
import {
  uint8ArrayFromHexString,
  uint8ArrayToHexString,
} from "./helpers/bufferFromHex.js"

// Used to determine if an object is a bundle without doing an instanceof check
const BUNDLE_MARKER = Symbol.for("_am_repo_bundle")

/**
 * A bundle is a collection of documents which have been exported using `Repo.exportBundle`
 */
export class Bundle {
  [BUNDLE_MARKER] = true
  docs: Map<DocumentId, DocBundle>

  constructor(
    docs: DocHandle<unknown>[],
    args?: { since?: Map<AutomergeUrl, Heads | UrlHeads> }
  ) {
    this.docs = new Map()
    for (const handle of docs) {
      const heads = Automerge.getHeads(handle.doc())
      let data: Uint8Array
      let deps: Heads
      const since = sinceForDoc(handle.url, args)
      if (since) {
        deps = since
        data = Automerge.saveSince(handle.doc(), since)
      } else {
        deps = []
        data = Automerge.save(handle.doc())
      }
      this.docs.set(handle.documentId, {
        heads,
        deps,
        data,
      })
    }
  }

  /**
   * A summary of the data in this bundle
   */
  get data(): Map<AutomergeUrl, DocBundle> {
    const data = new Map<AutomergeUrl, DocBundle>()
    for (const [id, bundle] of this.docs) {
      data.set(stringifyAutomergeUrl(id), {
        deps: bundle.deps,
        heads: bundle.heads,
        data: bundle.data,
      })
    }
    return data
  }

  /**
   * Encode this bundle into a Uint8Array
   *
   * The encoding is intended to be forwardss compatible
   * @returns
   */
  encode(): Uint8Array {
    return encodeBundle(this.docs)
  }

  /**
   * Attempt to decode a bundle from a Uint8Array
   *
   * @param data A
   * @returns
   */
  static decode(data: Uint8Array): Bundle {
    const docsMap = decodeBundle(data)
    const bundle = Object.create(Bundle.prototype)
    bundle[BUNDLE_MARKER] = true
    bundle.docs = docsMap
    return bundle
  }
}

function sinceForDoc(
  docUrl: AutomergeUrl,
  args?: { since?: Map<AutomergeUrl, Heads | UrlHeads> }
): Heads | undefined {
  let since: Heads | undefined
  let sinceArg = args?.since?.get(docUrl)
  if (sinceArg) {
    try {
      since = decodeHeads(sinceArg as UrlHeads)
    } catch (error) {
      since = sinceArg as Heads
    }
  }
  return since
}

type DocBundle = {
  heads: Heads
  deps: Heads
  data: Uint8Array
}

const MAGIC = new Uint8Array([148, 83, 96, 215])

function encodeBundle(docs: Map<DocumentId, DocBundle>): Uint8Array {
  // A bundle is:
  // - A 4 byte magic number
  // - A 1 byte version number
  // - A length prefixed array of document metadata where document metadata is
  //   - The length prefixed document ID
  //   - The length prefixed array of document heads
  //   - The length prefixed array of document dependencies (hashes which the bundle depends on)
  //   - The length of the document data in the bundle
  //   - The offset into the document data section where this documents data starts
  // - The concatenated document data

  // Calculate total size needed
  let totalSize = 0

  // Fixed header size
  totalSize += 4 // magic number
  totalSize += 1 // version
  totalSize += 4 // number of documents

  // Calculate size for each document header and data
  let totalDataSize = 0
  for (const [docId, bundle] of docs.entries()) {
    const docIdBytes = documentIdToBinary(docId)
    if (!docIdBytes) throw new Error(`Invalid document ID: ${docId}`)

    totalSize += 4 // doc ID length
    totalSize += docIdBytes.length // doc ID
    totalSize += 4 // number of heads
    totalSize += bundle.heads.length * 32 // heads (32 bytes each)
    totalSize += 4 // number of deps
    totalSize += bundle.deps.length * 32 // deps (32 bytes each)
    totalSize += 4 // data length
    totalSize += 4 // bundle offset

    totalDataSize += bundle.data.length
  }

  totalSize += totalDataSize // all document data

  // Create buffer with calculated size
  const buffer = new ArrayBuffer(totalSize)
  const output = new Uint8Array(buffer)
  const dataview = new DataView(buffer)
  let offset = 0

  // Magic number
  output.set(MAGIC, offset)
  offset += 4

  // Version
  dataview.setUint8(offset, 1)
  offset += 1

  // Number of documents
  dataview.setUint32(offset, docs.size)
  offset += 4

  // Write headers
  let bundleOffset = 0
  const headerSize = offset
  for (const [docId, bundle] of docs.entries()) {
    offset = writeDocHeader(
      output,
      dataview,
      offset,
      docId,
      bundle,
      bundleOffset
    )
    bundleOffset += bundle.data.length
  }

  // Write document data
  for (const [docId, bundle] of docs.entries()) {
    output.set(bundle.data, offset)
    offset += bundle.data.length
  }

  return output
}

function writeDocHeader(
  output: Uint8Array,
  dataview: DataView,
  offset: number,
  docId: DocumentId,
  bundle: DocBundle,
  bundleOffset: number
): number {
  const docIdBytes = documentIdToBinary(docId)
  if (!docIdBytes) throw new Error(`Invalid document ID: ${docId}`) // Should never happen

  // doc ID
  dataview.setUint32(offset, docIdBytes.length)
  offset += 4
  output.set(docIdBytes, offset)
  offset += docIdBytes.length

  // heads
  dataview.setUint32(offset, bundle.heads.length)
  offset += 4
  for (const head of bundle.heads) {
    const headBytes = uint8ArrayFromHexString(head)
    if (headBytes.length !== 32)
      throw new Error(`Invalid head length: ${headBytes.length}`)
    output.set(headBytes, offset)
    offset += 32
  }

  // deps
  dataview.setUint32(offset, bundle.deps.length)
  offset += 4
  for (const dep of bundle.deps) {
    const depBytes = uint8ArrayFromHexString(dep)
    if (depBytes.length !== 32)
      throw new Error(`Invalid dep length: ${depBytes.length}`)
    output.set(depBytes, offset)
    offset += 32
  }

  // data len
  dataview.setUint32(offset, bundle.data.length)
  offset += 4

  // bundle offset
  dataview.setUint32(offset, bundleOffset)
  offset += 4

  return offset
}

function decodeBundle(data: Uint8Array): Map<DocumentId, DocBundle> {
  const dataview = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0

  // Check magic number
  const magic = data.slice(offset, offset + 4)
  if (!magic.every((byte, i) => byte === MAGIC[i])) {
    throw new Error("Invalid bundle: incorrect magic number")
  }
  offset += 4

  // Check version
  const version = dataview.getUint8(offset)
  if (version !== 1) {
    throw new Error(`Unsupported bundle version: ${version}`)
  }
  offset += 1

  // Read number of documents
  const numDocs = dataview.getUint32(offset)
  offset += 4

  // Read document headers
  const docHeaders: Array<{
    docId: DocumentId
    heads: Heads
    deps: Heads
    dataLen: number
    bundleOffset: number
  }> = []

  for (let i = 0; i < numDocs; i++) {
    // Read doc ID
    const docIdLen = dataview.getUint32(offset)
    offset += 4
    const docIdBytes = data.slice(offset, offset + docIdLen)
    offset += docIdLen
    const docId = binaryToDocumentId(docIdBytes as BinaryDocumentId)

    // Read heads
    const numHeads = dataview.getUint32(offset)
    offset += 4
    const heads: Heads = []
    for (let j = 0; j < numHeads; j++) {
      const headBytes = data.slice(offset, offset + 32)
      offset += 32
      heads.push(uint8ArrayToHexString(headBytes))
    }

    // Read deps
    const numDeps = dataview.getUint32(offset)
    offset += 4
    const deps: Heads = []
    for (let j = 0; j < numDeps; j++) {
      const depBytes = data.slice(offset, offset + 32)
      offset += 32
      deps.push(uint8ArrayToHexString(depBytes))
    }

    // Read data length
    const dataLen = dataview.getUint32(offset)
    offset += 4

    // Read bundle offset
    const bundleOffset = dataview.getUint32(offset)
    offset += 4

    docHeaders.push({ docId, heads, deps, dataLen, bundleOffset })
  }

  // Read document data
  const docs = new Map<DocumentId, DocBundle>()
  const dataStart = offset

  for (const header of docHeaders) {
    const docData = data.slice(
      dataStart + header.bundleOffset,
      dataStart + header.bundleOffset + header.dataLen
    )

    docs.set(header.docId, {
      heads: header.heads,
      deps: header.deps,
      data: docData,
    })
  }

  return docs
}

export function isBundle(obj: any): obj is Bundle {
  return (
    typeof obj === "object" &&
    obj !== null &&
    Object.prototype.hasOwnProperty.call(obj, BUNDLE_MARKER)
  )
}
