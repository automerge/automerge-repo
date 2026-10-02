import { Encoder } from "cbor-x"
import { describe, expect, it } from "vitest"
import {
  decodeEphemeral,
  encodeEphemeral,
  rememberEphemeral,
  topicKey,
} from "../src/ephemeral.js"

const message = {
  messageId: "message",
  origin: { kind: "repo", id: "origin", path: ["child"] },
  payload: new Uint8Array([1, 2, 3]),
}

describe("private ephemeral codec and cache", () => {
  it("copies inputs and outputs and uses a versioned tuple", () => {
    const bytes = encodeEphemeral(message)
    const decoded = decodeEphemeral(bytes)!
    expect(decoded).toEqual(message)
    decoded.payload.fill(9)
    ;(decoded.origin.path as string[]).push("other")
    expect(decodeEphemeral(bytes)).toEqual(message)
    expect(decoded.payload).not.toBe(message.payload)
    expect(decoded.origin.path).not.toBe(message.origin.path)
  })

  it("limits the complete encoding, not just the payload", () => {
    const overhead =
      encodeEphemeral({ ...message, payload: new Uint8Array(65000) }).length -
      65000
    const exact = { ...message, payload: new Uint8Array(65536 - overhead) }
    expect(encodeEphemeral(exact)).toHaveLength(65536)
    expect(decodeEphemeral(encodeEphemeral(exact))).toEqual(exact)
    expect(() =>
      encodeEphemeral({
        ...exact,
        payload: new Uint8Array(exact.payload.length + 1),
      })
    ).toThrow()
    expect(() =>
      encodeEphemeral({ ...message, payload: new Uint8Array(65536) })
    ).toThrow()
    expect(decodeEphemeral(new Uint8Array(65537))).toBeUndefined()
  })

  it("rejects malformed tuples and bounded metadata", () => {
    const encoder = new Encoder({ useRecords: false })
    for (const tuple of [
      [],
      [2, message.messageId, message.origin, message.payload],
      [1, "", message.origin, message.payload],
      [1, "x".repeat(257), message.origin, message.payload],
      [1, "ok", { ...message.origin, kind: "" }, message.payload],
      [1, "ok", { ...message.origin, id: "x".repeat(257) }, message.payload],
      [
        1,
        "ok",
        { ...message.origin, path: Array(17).fill("a") },
        message.payload,
      ],
      [1, "ok", { ...message.origin, path: [""] }, message.payload],
      [1, "ok", message.origin, [1]],
      [1, "ok", message.origin, message.payload, 5],
    ])
      expect(decodeEphemeral(encoder.encode(tuple))).toBeUndefined()
    expect(decodeEphemeral(new Uint8Array([255]))).toBeUndefined()
    const bytes = encodeEphemeral(message)
    expect(decodeEphemeral(new Uint8Array([...bytes, 1]))).toBeUndefined()
  })

  it("keys by the full topic and ID, evicting the oldest of 4096", () => {
    const seen = new Set<string>()
    const a = topicKey(new Uint8Array(32))
    const bytes = new Uint8Array(32)
    bytes[31] = 1
    const b = topicKey(bytes)
    expect(a).not.toBe(b)
    expect(rememberEphemeral(seen, `${a}:same`)).toBe(true)
    expect(rememberEphemeral(seen, `${b}:same`)).toBe(true)
    expect(rememberEphemeral(seen, `${a}:same`)).toBe(false)
    for (let i = 0; i < 4095; i++) rememberEphemeral(seen, `${a}:${i}`)
    expect(seen.size).toBe(4096)
    expect(seen.has(`${a}:same`)).toBe(false)
    expect(seen.has(`${b}:same`)).toBe(true)
  })
})
