// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  checkpointForCommit,
  checkpointId,
  commitId,
  idBytes,
  isLegacyId,
  sedimentreeId,
} from "../../src/sedimentree/ids.js"

describe("plain logical identifiers", () => {
  it.each([16, 32])(
    "canonicalizes %i-byte hex without changing its length",
    length => {
      const bytes = new Uint8Array(length).fill(0xab)
      const id = sedimentreeId("AB".repeat(length))
      expect(id).toBe("ab".repeat(length))
      expect(sedimentreeId(bytes)).toBe(id)
      expect(idBytes(id)).toEqual(bytes)
      expect(isLegacyId(id)).toBe(length === 16)
      bytes.fill(0)
      const output = idBytes(id)
      output.fill(0)
      expect(idBytes(id)).toEqual(new Uint8Array(length).fill(0xab))
    }
  )

  it("accepts all 16-byte logical IDs, not just UUIDs, without native padding", () => {
    expect(sedimentreeId(new Uint8Array(16))).toBe("00".repeat(16))
    expect(idBytes(sedimentreeId("ff".repeat(16)))).toHaveLength(16)
    expect(isLegacyId(sedimentreeId("ff".repeat(32)))).toBe(false)
  })

  it.each(["00".repeat(32), "AB".repeat(16) + "00".repeat(16)])(
    "rejects the reserved native embedding %s",
    value => {
      expect(() => sedimentreeId(value)).toThrow(TypeError)
      expect(() =>
        sedimentreeId(
          Uint8Array.from(value.match(/../g)!, byte => parseInt(byte, 16))
        )
      ).toThrow(TypeError)
    }
  )

  it.each([0, 1, 12, 15, 17, 31, 33, 64])(
    "rejects unsupported logical length %i",
    length => {
      expect(() => sedimentreeId("ab".repeat(length))).toThrow(TypeError)
      expect(() => sedimentreeId(new Uint8Array(length))).toThrow(TypeError)
    }
  )

  it.each([
    "a",
    "gg".repeat(16),
    "0x" + "ab".repeat(16),
    " ab".repeat(16),
    "ab".repeat(16) + "\n",
  ])("rejects malformed hex %j", value => {
    expect(() => sedimentreeId(value)).toThrow(TypeError)
  })

  it("rejects native/WASM-shaped objects instead of coercing or truncating them", () => {
    const native = {
      toBytes: () => new Uint8Array(32),
      toString: () => "ab".repeat(32),
    }
    expect(() => sedimentreeId(native as unknown as Uint8Array)).toThrow(
      TypeError
    )
  })

  it("keeps 32-byte commit identities distinct from 12-byte checkpoint prefixes", () => {
    const hex = "ABCDEF".repeat(10) + "1234"
    const id = commitId(hex)
    expect(id).toBe(hex.toLowerCase())
    expect(commitId(new Uint8Array(32))).toBe("00".repeat(32))
    expect(checkpointForCommit(id)).toBe(hex.slice(0, 24).toLowerCase())
    expect(checkpointId("AB".repeat(12))).toBe("ab".repeat(12))
    expect(checkpointId(new Uint8Array(12))).toBe("00".repeat(12))
    expect(idBytes(checkpointForCommit(id))).toHaveLength(12)
    expect(() => checkpointId(id)).toThrow(TypeError)
    expect(() => commitId(checkpointForCommit(id))).toThrow(TypeError)
  })

  it.each([0, 1, 16, 31, 33])("rejects invalid commit length %i", length => {
    expect(() => commitId(new Uint8Array(length))).toThrow(TypeError)
  })
  it.each([0, 1, 11, 13, 16, 32])(
    "rejects invalid checkpoint length %i",
    length => {
      expect(() => checkpointId(new Uint8Array(length))).toThrow(TypeError)
    }
  )
})
