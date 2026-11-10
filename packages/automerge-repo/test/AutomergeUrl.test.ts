import assert from "assert"
import bs58check from "bs58check"
import { describe, it } from "vitest"
import {
  binaryToDocumentId,
  documentIdToBinary,
  generateAutomergeUrl,
  getHeadsFromUrl,
  isValidAutomergeUrl,
  isValidDocumentId,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "../src/AutomergeUrl.js"
import type {
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
  UrlHeads,
} from "../src/types.js"
import {
  interpretAsDocumentId,
  normalizeDocumentId,
} from "../src/AutomergeUrl.js"

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
const badPrefixUrl = `yjs😉:${goodDocumentId}` as AutomergeUrl

const badChecksumDocumentId = "badbadbad" as DocumentId

describe("AutomergeUrl", () => {
  describe("generateAutomergeUrl", () => {
    it("should generate a valid Automerge URL", () => {
      const url = generateAutomergeUrl()
      assert(url.startsWith("automerge:"))
      assert.equal(parseAutomergeUrl(url).binaryDocumentId.length, 32)
    })

    it("writes an ID in its short form", () => {
      const url = generateAutomergeUrl()
      const encoded = url.slice("automerge:".length)
      assert.equal(bs58check.decode(encoded).length, 16)
    })
  })

  describe("IDs whose second half is zero", () => {
    it("are written in the short form", () => {
      assert.equal(
        binaryToDocumentId(zeroSuffixedBinaryDocumentId),
        shortDocumentId
      )
      assert.equal(
        stringifyAutomergeUrl({ documentId: zeroSuffixedBinaryDocumentId }),
        shortUrl
      )
      assert.equal(stringifyAutomergeUrl(longDocumentId), shortUrl)
    })

    it("are read in either form as one ID", () => {
      for (const url of [shortUrl, longUrl]) {
        assert(isValidAutomergeUrl(url))
        assert.equal(parseAutomergeUrl(url).documentId, shortDocumentId)
        assert.deepEqual(
          parseAutomergeUrl(url).binaryDocumentId,
          zeroSuffixedBinaryDocumentId
        )
        assert.equal(interpretAsDocumentId(url), shortDocumentId)
      }
      for (const id of [shortDocumentId, longDocumentId]) {
        assert(isValidDocumentId(id))
        assert.equal(interpretAsDocumentId(id), shortDocumentId)
        assert.deepEqual(documentIdToBinary(id), zeroSuffixedBinaryDocumentId)
      }
    })

    it("are 32 bytes in binary outside normalizeDocumentId", () => {
      assert.throws(() =>
        stringifyAutomergeUrl({ documentId: shortBinaryDocumentId })
      )
      assert.throws(() => interpretAsDocumentId(shortBinaryDocumentId))
      assert.equal(
        interpretAsDocumentId(zeroSuffixedBinaryDocumentId),
        shortDocumentId
      )
    })

    it("are normalized in any form with normalizeDocumentId", () => {
      for (const id of [
        shortBinaryDocumentId,
        zeroSuffixedBinaryDocumentId,
        shortDocumentId,
        longDocumentId,
        shortUrl,
        longUrl,
      ]) {
        assert.equal(normalizeDocumentId(id), shortDocumentId)
      }
    })

    it("keep path and heads when a long URL is re-stringified", () => {
      const head = bs58check.encode(new Uint8Array([1, 2, 3, 4]))
      const parsed = parseAutomergeUrl(`${longUrl}/a/b#${head}` as AutomergeUrl)
      assert.equal(
        stringifyAutomergeUrl({
          documentId: parsed.documentId,
          heads: parsed.heads,
          segments: parsed.segments,
        }),
        `${shortUrl}/a/b#${head}`
      )
    })
  })

  describe("normalizeDocumentId", () => {
    it("passes other 32-byte IDs through", () => {
      assert.equal(normalizeDocumentId(goodBinaryDocumentId), goodDocumentId)
      assert.equal(normalizeDocumentId(goodDocumentId), goodDocumentId)
      assert.equal(normalizeDocumentId(goodUrl), goodDocumentId)
    })

    it("rejects other lengths and garbage", () => {
      assert.throws(() =>
        normalizeDocumentId(new Uint8Array(8) as BinaryDocumentId)
      )
      assert.throws(() =>
        normalizeDocumentId(new Uint8Array(0) as BinaryDocumentId)
      )
      assert.throws(() =>
        normalizeDocumentId(
          binaryToDocumentId(new Uint8Array(24) as BinaryDocumentId)
        )
      )
      assert.throws(() => normalizeDocumentId(badChecksumDocumentId))
      assert.throws(() => normalizeDocumentId(badChecksumUrl))
    })
  })

  describe("stringifyAutomergeUrl", () => {
    it("should stringify a binary document ID", () => {
      const url = stringifyAutomergeUrl({ documentId: goodBinaryDocumentId })
      assert.strictEqual(url, goodUrl)
    })

    it("should stringify a string document ID", () => {
      const url = stringifyAutomergeUrl({ documentId: goodDocumentId })
      assert.strictEqual(url, goodUrl)
    })

    it("supports passing a document ID without wrapping it in an object", () => {
      const url1 = stringifyAutomergeUrl(goodDocumentId)
      const url2 = stringifyAutomergeUrl({ documentId: goodDocumentId })
      assert.equal(url1, url2)
    })
  })

  describe("parseAutomergeUrl", () => {
    it("should parse a valid url", () => {
      const { binaryDocumentId, documentId } = parseAutomergeUrl(goodUrl)
      assert.deepEqual(binaryDocumentId, goodBinaryDocumentId)
      assert.equal(documentId, goodDocumentId)
    })

    it("should throw on url with invalid checksum", () => {
      assert.throws(() => parseAutomergeUrl(badChecksumUrl))
    })

    it("should throw on url with invalid prefix", () => {
      assert.throws(() => parseAutomergeUrl(badPrefixUrl))
    })
  })

  describe("isValidAutomergeUrl", () => {
    it("should return true for a valid url", () => {
      assert(isValidAutomergeUrl(goodUrl) === true)
    })

    it("should return false for null url", () => {
      assert(isValidAutomergeUrl(null) === false)
    })

    it("should return false for a url with invalid checksum", () => {
      assert(isValidAutomergeUrl(badChecksumUrl) === false)
    })

    it("should return false for a url with invalid prefix", () => {
      assert(isValidAutomergeUrl(badPrefixUrl) === false)
    })

    it("should return false for a documentId with an invalid checksum", () => {
      assert.throws(() =>
        stringifyAutomergeUrl({ documentId: badChecksumDocumentId })
      )
      const url = `automerge:${badChecksumDocumentId}` as AutomergeUrl
      assert(isValidAutomergeUrl(url) === false)
    })

    it("should return false for a documentId that is just some random type", () => {
      assert(isValidAutomergeUrl({ foo: "bar" } as unknown) === false)
    })
  })

  it("should allow arbitrary 32-byte ids", () => {
    const raw = new Uint8Array(32).fill(7)
    const documentId = binaryToDocumentId(raw as BinaryDocumentId)
    const url = stringifyAutomergeUrl({ documentId })
    assert.deepStrictEqual(interpretAsDocumentId(url), documentId)
  })

  it("should reject ids of any other length", () => {
    // 16 bytes is the short form of a 32-byte ID, so valid as a string.
    for (const length of [0, 9, 15, 17, 31, 33]) {
      const raw = new Uint8Array(length).fill(7) as BinaryDocumentId
      const documentId = binaryToDocumentId(raw)
      assert(!isValidDocumentId(documentId))
      assert(!isValidAutomergeUrl(`automerge:${documentId}`))
      assert.throws(() => stringifyAutomergeUrl({ documentId }))
      assert.throws(() => interpretAsDocumentId(documentId))
      assert.throws(() => interpretAsDocumentId(raw))
    }
  })
})

describe("AutomergeUrl with heads", () => {
  // Create some sample encoded heads for testing
  const head1 = bs58check.encode(new Uint8Array([1, 2, 3, 4])) as string
  const head2 = bs58check.encode(new Uint8Array([5, 6, 7, 8])) as string
  const goodHeads = [head1, head2] as UrlHeads
  const urlWithHeads = `${goodUrl}#${head1}|${head2}` as AutomergeUrl
  const invalidHead = "not-base58-encoded"
  const invalidHeads = [invalidHead] as UrlHeads

  describe("stringifyAutomergeUrl", () => {
    it("should stringify a url with heads", () => {
      const url = stringifyAutomergeUrl({
        documentId: goodDocumentId,
        heads: goodHeads,
      })
      assert.strictEqual(url, urlWithHeads)
    })

    it("should throw if heads are not valid base58check", () => {
      assert.throws(() =>
        stringifyAutomergeUrl({
          documentId: goodDocumentId,
          heads: invalidHeads,
        })
      )
    })

    it("sorts heads so order-permuted inputs produce identical urls", () => {
      const a = stringifyAutomergeUrl({
        documentId: goodDocumentId,
        heads: [head1, head2] as UrlHeads,
      })
      const b = stringifyAutomergeUrl({
        documentId: goodDocumentId,
        heads: [head2, head1] as UrlHeads,
      })
      assert.strictEqual(a, b)
    })
  })

  describe("parseAutomergeUrl", () => {
    it("should parse a url with heads", () => {
      const { documentId, heads } = parseAutomergeUrl(urlWithHeads)
      assert.equal(documentId, goodDocumentId)
      assert.deepEqual(heads, [head1, head2])
    })

    it("should parse a url without heads", () => {
      const { documentId, heads } = parseAutomergeUrl(goodUrl)
      assert.equal(documentId, goodDocumentId)
      assert.equal(heads, undefined)
    })

    it("should throw on url with invalid heads encoding", () => {
      const badUrl = `${goodUrl}#${invalidHead}` as AutomergeUrl
      assert.throws(() => parseAutomergeUrl(badUrl))
    })
  })

  describe("isValidAutomergeUrl", () => {
    it("should return true for a valid url with heads", () => {
      assert(isValidAutomergeUrl(urlWithHeads) === true)
    })

    it("should return false for a url with invalid heads", () => {
      const badUrl = `${goodUrl}#${invalidHead}` as AutomergeUrl
      assert(isValidAutomergeUrl(badUrl) === false)
    })
  })

  describe("getHeadsFromUrl", () => {
    it("should return heads from a valid url", () => {
      const heads = getHeadsFromUrl(urlWithHeads)
      assert.deepEqual(heads, [head1, head2])
    })

    it("should return undefined for url without heads", () => {
      const heads = getHeadsFromUrl(goodUrl)
      assert.equal(heads, undefined)
    })
  })
  it("should handle a single head correctly", () => {
    const urlWithOneHead = `${goodUrl}#${head1}` as AutomergeUrl
    const { heads } = parseAutomergeUrl(urlWithOneHead)
    assert.deepEqual(heads, [head1])
  })

  it("should round-trip urls with heads", () => {
    const originalUrl = urlWithHeads
    const parsed = parseAutomergeUrl(originalUrl)
    const roundTripped = stringifyAutomergeUrl({
      documentId: parsed.documentId,
      heads: parsed.heads,
    })
    assert.equal(roundTripped, originalUrl)
  })

  describe("should reject malformed urls", () => {
    it("should reject urls with trailing delimiter", () => {
      assert(!isValidAutomergeUrl(`${goodUrl}#${head1}:` as AutomergeUrl))
    })

    it("should reject urls with empty head", () => {
      assert(!isValidAutomergeUrl(`${goodUrl}#|${head1}` as AutomergeUrl))
    })

    it("should reject urls with multiple hash characters", () => {
      assert(
        !isValidAutomergeUrl(`${goodUrl}#${head1}#${head2}` as AutomergeUrl)
      )
    })
  })
})

describe("empty heads section", () => {
  it("should treat bare # as empty heads array", () => {
    const urlWithEmptyHeads = `${goodUrl}#` as AutomergeUrl
    const { heads } = parseAutomergeUrl(urlWithEmptyHeads)
    assert.deepEqual(heads, [])
  })

  it("should round-trip empty heads array", () => {
    const original = `${goodUrl}#` as AutomergeUrl
    const parsed = parseAutomergeUrl(original)
    const roundTripped = stringifyAutomergeUrl({
      documentId: parsed.documentId,
      heads: parsed.heads,
    })
    assert.equal(roundTripped, original)
  })

  it("should distinguish between no heads and empty heads", () => {
    const noHeads = parseAutomergeUrl(goodUrl)
    const emptyHeads = parseAutomergeUrl(`${goodUrl}#` as AutomergeUrl)

    assert.equal(noHeads.heads, undefined)
    assert.deepEqual(emptyHeads.heads, [])
  })
})
