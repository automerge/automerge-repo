import assert from "assert"
import bs58check from "bs58check"
import { describe, it } from "vitest"
import {
  generateAutomergeUrl,
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
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
  })
})
