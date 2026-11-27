import assert from "assert"
import bs58check from "bs58check"
import { describe, it } from "vitest"
import {
  binaryToDocumentId,
  documentIdToBinary,
  interpretAsDocumentId,
  isValidDocumentId,
  isValidDocumentUrl,
  isValidUrlScheme,
  parseDocumentUrl,
  parseUrlScheme,
  stringifyDocumentUrl,
  type DocumentUrlOptions,
  type UrlDocType,
} from "../src/DocumentUrl.js"
import { automerge } from "../src/automerge/docType.js"
import { isValidAutomergeUrl, type AutomergeUrl } from "../src/automerge/url.js"
import type {
  BinaryDocumentId,
  DocumentId,
  DocumentUrl,
  UrlHeads,
} from "../src/types.js"

const shortBinaryDocumentId = Uint8Array.from([
  241, 194, 156, 132, 116, 200, 74, 222, 184, 0, 190, 71, 98, 125, 51, 191,
]) as BinaryDocumentId
const shortDocumentId = "4NMNnkMhL8jXrdJ9jamS58PAVdXu" as DocumentId
const shortUrl = `automerge:${shortDocumentId}` as AutomergeUrl

const zeroSuffixedBinaryDocumentId = new Uint8Array(32) as BinaryDocumentId
zeroSuffixedBinaryDocumentId.set(shortBinaryDocumentId)
const longDocumentId = bs58check.encode(
  zeroSuffixedBinaryDocumentId
) as DocumentId
const longUrl = `automerge:${longDocumentId}` as AutomergeUrl

const goodBinaryDocumentId = new Uint8Array(32) as BinaryDocumentId
goodBinaryDocumentId.set(shortBinaryDocumentId)
goodBinaryDocumentId.set(shortBinaryDocumentId, 16)
const goodDocumentId = bs58check.encode(goodBinaryDocumentId) as DocumentId
const goodUrl = `automerge:${goodDocumentId}` as AutomergeUrl
const badChecksumUrl = "automerge:badbadbad" as AutomergeUrl

const badChecksumDocumentId = "badbadbad" as DocumentId

describe("DocumentId and DocumentUrl", () => {
  describe("IDs whose second half is zero", () => {
    it("are written in the short form", () => {
      assert.equal(
        binaryToDocumentId(zeroSuffixedBinaryDocumentId),
        shortDocumentId
      )
    })

    it("are read in either form as one ID", () => {
      for (const url of [shortUrl, longUrl]) {
        assert.equal(interpretAsDocumentId(url), shortDocumentId)
      }
      for (const id of [shortDocumentId, longDocumentId]) {
        assert(isValidDocumentId(id))
        assert.equal(interpretAsDocumentId(id), shortDocumentId)
        assert.deepEqual(documentIdToBinary(id), zeroSuffixedBinaryDocumentId)
      }
    })

    it("are read from binary in either form as one ID", () => {
      for (const id of [shortBinaryDocumentId, zeroSuffixedBinaryDocumentId]) {
        assert.equal(interpretAsDocumentId(id), shortDocumentId)
      }
    })
  })

  describe("interpretAsDocumentId", () => {
    it("passes other 32-byte IDs through", () => {
      assert.equal(interpretAsDocumentId(goodBinaryDocumentId), goodDocumentId)
      assert.equal(interpretAsDocumentId(goodDocumentId), goodDocumentId)
      assert.equal(interpretAsDocumentId(goodUrl), goodDocumentId)
    })

    it("rejects other lengths and garbage", () => {
      assert.throws(() =>
        interpretAsDocumentId(new Uint8Array(8) as BinaryDocumentId)
      )
      assert.throws(() =>
        interpretAsDocumentId(new Uint8Array(0) as BinaryDocumentId)
      )
      assert.throws(() =>
        interpretAsDocumentId(
          binaryToDocumentId(new Uint8Array(24) as BinaryDocumentId)
        )
      )
      assert.throws(() => interpretAsDocumentId(badChecksumDocumentId))
      assert.throws(() => interpretAsDocumentId(badChecksumUrl))
    })
  })

  it("should reject ids of any other length", () => {
    // 16 bytes is the short form of a 32-byte ID, so valid as a string.
    for (const length of [0, 9, 15, 17, 31, 33]) {
      const raw = new Uint8Array(length).fill(7) as BinaryDocumentId
      const documentId = binaryToDocumentId(raw)
      assert(!isValidDocumentId(documentId))
      assert.throws(() => interpretAsDocumentId(documentId))
      assert.throws(() => interpretAsDocumentId(raw))
    }
  })

  describe("document URL schemes and custom formats", () => {
    const notesUrl = `notes:${goodDocumentId}` as DocumentUrl<"notes">
    const heads = [bs58check.encode(new Uint8Array(32).fill(1))] as UrlHeads
    // A doc type with a completely custom URL layout (`notes://v1/<hex>`).
    const customNotes: UrlDocType<"notes"> = {
      scheme: "notes",
      openUrl(url) {
        const m = url.match(/^notes:\/\/v1\/([0-9a-f]{64})$/)
        if (!m) throw new Error(`Invalid notes URL: ${url}`)
        const bytes = Uint8Array.from(
          m[1].match(/../g)!.map(b => parseInt(b, 16))
        ) as BinaryDocumentId
        return { documentId: bytes }
      },
    }
    const goodHex = [...goodBinaryDocumentId]
      .map(b => b.toString(16).padStart(2, "0"))
      .join("")
    const customNotesUrl = `notes://v1/${goodHex}` as DocumentUrl<"notes">

    it("uses automerge: by default, and parses default <scheme>:<id> URLs", () => {
      assert.equal(
        stringifyDocumentUrl({ documentId: goodDocumentId }),
        goodUrl
      )
      assert.equal(parseDocumentUrl(goodUrl).scheme, "automerge")
      assert.equal(parseDocumentUrl(goodUrl).documentId, goodDocumentId)
    })

    it("writes and parses another doc type's default URL", () => {
      const url = stringifyDocumentUrl({
        documentId: goodDocumentId,
        scheme: "notes",
      })
      assert.equal(url, notesUrl)
      const parsed = parseDocumentUrl(url)
      assert.equal(parsed.scheme, "notes")
      assert.equal(parsed.documentId, goodDocumentId)
      assert(isValidDocumentUrl(url))
      assert(isValidDocumentUrl(url, "notes"))
      assert(!isValidDocumentUrl(url, "automerge"))
      assert(!isValidAutomergeUrl(url))
    })

    it("extracts schemes with parseUrlScheme and parses custom formats with docType", () => {
      assert.equal(parseUrlScheme(customNotesUrl), "notes")
      assert.equal(parseUrlScheme(`${goodUrl}/a/b#${heads[0]}`), "automerge")
      assert.equal(parseUrlScheme(goodDocumentId), undefined)
      assert.equal(parseUrlScheme("Notes:abc"), undefined)
      assert.equal(parseUrlScheme("notes:"), undefined)

      // Without docType, a custom format does not match default `<scheme>:<base58Id>`.
      assert(!isValidDocumentUrl(customNotesUrl))
      assert.throws(() => parseDocumentUrl(customNotesUrl))

      // With docType, custom formats validate and parse cleanly.
      assert(isValidDocumentUrl(customNotesUrl, customNotes))
      assert(!isValidDocumentUrl("notes://v1/not-hex", customNotes))
      assert(!isValidDocumentUrl(goodUrl, customNotes))
      const parsed = parseDocumentUrl(customNotesUrl, customNotes)
      assert.equal(parsed.scheme, "notes")
      assert.equal(parsed.documentId, goodDocumentId)
      assert.deepEqual(parsed.binaryDocumentId, goodBinaryDocumentId)

      // Generic helpers also work on automerge: URLs with paths/heads via `automerge`.
      const amWithSuffix = `${goodUrl}/items/@0#${heads[0]}` as AutomergeUrl
      assert(isValidDocumentUrl(amWithSuffix, automerge))
      assert.deepEqual(parseDocumentUrl(amWithSuffix, automerge), {
        scheme: "automerge",
        binaryDocumentId: goodBinaryDocumentId,
        documentId: goodDocumentId,
      })
    })

    it("rejects invalid schemes and extra suffixes on default URLs", () => {
      assert(!isValidDocumentUrl(`Notes:${goodDocumentId}`))
      assert(!isValidDocumentUrl(`9lives:${goodDocumentId}`))
      assert(!isValidDocumentUrl(`automerge:notes:${goodDocumentId}`))
      assert(!isValidDocumentUrl(`automerge:${goodDocumentId}0`))
      assert(!isValidDocumentUrl(`${notesUrl}/extra`))
      assert(!isValidDocumentUrl("http://example.com"))
      assert(!isValidUrlScheme("Notes"))
      assert(!isValidUrlScheme("9lives"))
      assert(isValidUrlScheme("g-counter2+v1.0"))
      assert.throws(() =>
        stringifyDocumentUrl({
          documentId: goodDocumentId,
          scheme: "notes:",
        })
      )
    })

    it("interprets default, Automerge, and custom (with docType) URLs as document IDs", () => {
      assert.equal(interpretAsDocumentId(notesUrl), goodDocumentId)
      assert.equal(
        interpretAsDocumentId(`${goodUrl}/a/b#${heads[0]}` as AutomergeUrl),
        goodDocumentId
      )
      assert.equal(
        interpretAsDocumentId(customNotesUrl, customNotes),
        goodDocumentId
      )
      assert.throws(() => interpretAsDocumentId(customNotesUrl))
    })

    it("accepts dynamically built options", () => {
      const docOptions: DocumentUrlOptions = { documentId: goodDocumentId }
      assert.equal(stringifyDocumentUrl(docOptions), goodUrl)
      docOptions.scheme = "notes"
      assert.equal(stringifyDocumentUrl(docOptions), notesUrl)
    })

    it("types URLs with their doc type's scheme", () => {
      const named: DocumentUrl<"notes"> = stringifyDocumentUrl({
        documentId: goodDocumentId,
        scheme: "notes",
      })
      const automergeUrl: AutomergeUrl = stringifyDocumentUrl({
        documentId: goodDocumentId,
      })
      const any: DocumentUrl = named
      // @ts-expect-error a notes URL is not an Automerge document's
      const wrong: AutomergeUrl = named
      const scheme: "notes" = parseDocumentUrl(named).scheme
      const customScheme: "notes" = parseDocumentUrl(
        customNotesUrl,
        customNotes
      ).scheme
      void [automergeUrl, any, wrong, scheme, customScheme]
    })
  })
})
