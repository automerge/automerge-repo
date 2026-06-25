import { describe, expect, it } from "vitest"

import {
  INLINE_THRESHOLD,
  decodeCompound,
  encodeExternal,
  encodeInline,
  shouldInline,
  splitMeta,
} from "../../src/subduction/codec.js"

const bytes = (...xs: number[]) => Uint8Array.from(xs)

const randomBytes = (n: number, seed: number): Uint8Array => {
  // Deterministic LCG so failures reproduce.
  const out = new Uint8Array(n)
  let s = seed >>> 0
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    out[i] = s & 0xff
  }
  return out
}

describe("subduction codec", () => {
  it("round-trips an inline value", () => {
    const meta = bytes(1, 2, 3, 4)
    const blob = bytes(9, 8, 7)
    const decoded = decodeCompound(encodeInline(meta, blob))
    expect(decoded?.kind).toBe("inline")
    if (decoded?.kind !== "inline") throw new Error("unreachable")
    expect(Array.from(decoded.meta)).toEqual([1, 2, 3, 4])
    expect(Array.from(decoded.blob)).toEqual([9, 8, 7])
  })

  it("round-trips an external value", () => {
    const meta = bytes(5, 6, 7, 8, 9)
    const decoded = decodeCompound(encodeExternal(meta))
    expect(decoded?.kind).toBe("external")
    if (decoded?.kind !== "external") throw new Error("unreachable")
    expect(Array.from(decoded.meta)).toEqual([5, 6, 7, 8, 9])
  })

  it("round-trips an empty blob inline", () => {
    const meta = bytes(42)
    const decoded = decodeCompound(encodeInline(meta, new Uint8Array(0)))
    expect(decoded?.kind).toBe("inline")
    if (decoded?.kind !== "inline") throw new Error("unreachable")
    expect(Array.from(decoded.meta)).toEqual([42])
    expect(decoded.blob.byteLength).toBe(0)
  })

  it("is not confused by meta bytes that look like tags", () => {
    // meta starting with the tag bytes must still decode correctly, since the
    // tag is the first byte of the *record*, not of the meta.
    const meta = bytes(0x00, 0x01, 0x00, 0x01)
    const blob = bytes(0x01, 0x00)
    const decoded = decodeCompound(encodeInline(meta, blob))
    if (decoded?.kind !== "inline") throw new Error("expected inline")
    expect(Array.from(decoded.meta)).toEqual([0x00, 0x01, 0x00, 0x01])
    expect(Array.from(decoded.blob)).toEqual([0x01, 0x00])
  })

  it("shouldInline respects the threshold boundary", () => {
    expect(shouldInline(new Uint8Array(0))).toBe(true)
    expect(shouldInline(new Uint8Array(INLINE_THRESHOLD))).toBe(true)
    expect(shouldInline(new Uint8Array(INLINE_THRESHOLD + 1))).toBe(false)
  })

  it("splitMeta returns meta + external flag without the inline blob", () => {
    const meta = randomBytes(64, 1)
    const blob = randomBytes(4096, 2)

    const inline = splitMeta(encodeInline(meta, blob))
    expect(inline?.external).toBe(false)
    expect(Array.from(inline!.meta)).toEqual(Array.from(meta))

    const external = splitMeta(encodeExternal(meta))
    expect(external?.external).toBe(true)
    expect(Array.from(external!.meta)).toEqual(Array.from(meta))
  })

  it("returns null on malformed buffers", () => {
    expect(decodeCompound(new Uint8Array(0))).toBeNull()
    expect(decodeCompound(bytes(0x00, 0, 0))).toBeNull() // inline, truncated length prefix
    expect(decodeCompound(bytes(0x00, 0, 0, 0, 10, 1, 2))).toBeNull() // meta_len exceeds buffer
    expect(decodeCompound(bytes(0x02, 1, 2, 3))).toBeNull() // unknown tag (e.g. legacy raw meta)
  })

  it("round-trips arbitrary meta/blob pairs (randomised)", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const metaLen = seed % 130
      const blobLen = (seed * 7) % 500
      const meta = randomBytes(metaLen, seed)
      const blob = randomBytes(blobLen, seed * 31 + 1)
      const decoded = decodeCompound(encodeInline(meta, blob))
      if (decoded?.kind !== "inline")
        throw new Error(`seed ${seed}: not inline`)
      expect(Array.from(decoded.meta)).toEqual(Array.from(meta))
      expect(Array.from(decoded.blob)).toEqual(Array.from(blob))
    }
  })
})
