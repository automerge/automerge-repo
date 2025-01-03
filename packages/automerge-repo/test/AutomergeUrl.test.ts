import assert from "assert"
import bs58check from "bs58check"
import { describe, it } from "vitest"
import {
  generateAutomergeUrl,
  getHeadsFromUrl,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  UrlHeads,
} from "../src/AutomergeUrl.js"
import type {
  AutomergeUrl,
  BinaryDocumentId,
  DocumentId,
} from "../src/types.js"

const goodUrl = "automerge:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl
const badChecksumUrl = "automerge:badbadbad" as AutomergeUrl
const badPrefixUrl = "yjs😉:4NMNnkMhL8jXrdJ9jamS58PAVdXu" as AutomergeUrl

const goodDocumentId = "4NMNnkMhL8jXrdJ9jamS58PAVdXu" as DocumentId
const badChecksumDocumentId = "badbadbad" as DocumentId
const badUuidDocumentId = bs58check.encode(
  new Uint8Array([1, 2, 3, 4, 42, -1, 69, 777])
) as DocumentId

const goodBinaryDocumentId = Uint8Array.from([
  241, 194, 156, 132, 116, 200, 74, 222, 184, 0, 190, 71, 98, 125, 51, 191,
]) as BinaryDocumentId

describe("AutomergeUrl", () => {
  describe("generateAutomergeUrl", () => {
    it("should generate a valid Automerge URL", () => {
      const url = generateAutomergeUrl()
      assert(url.startsWith("automerge:"))
      assert(parseAutomergeUrl(url).binaryDocumentId)
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
      const url = stringifyAutomergeUrl({ documentId: badChecksumDocumentId })
      assert(isValidAutomergeUrl(url) === false)
    })

    it("should return false for a documentId that is not a valid UUID ", () => {
      const url = stringifyAutomergeUrl({ documentId: badUuidDocumentId })
      assert(isValidAutomergeUrl(url) === false)
    })

    it("should return false for a documentId that is just some random type", () => {
      assert(isValidAutomergeUrl({ foo: "bar" } as unknown) === false)
    })
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
