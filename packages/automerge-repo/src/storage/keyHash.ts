import { next as A } from "@automerge/automerge/slim"
import * as sha256 from "fast-sha256"
import { mergeArrays } from "../helpers/mergeArrays.js"

export function keyHash(binary: Uint8Array) {
  // calculate hash
  const hash = sha256.hash(binary)
  return bufferToHexString(hash)
}

export function headsHash(heads: A.Heads): string {
  const encoder = new TextEncoder()
  const headsbinary = mergeArrays(heads.map((h: string) => encoder.encode(h)))
  return keyHash(headsbinary)
}

function bufferToHexString(data: Uint8Array) {
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("")
}
