import { hexToUint8Array, uint8ArrayToHex } from "./utilities.js"

/**
 * A sync server's 32-byte verifying key, as lowercase hex.
 */
export type RelayKey = string & { readonly __relayKey: unique symbol }

/** The key of the sync server with `verifyingKey`. */
export function relayKey(verifyingKey: Uint8Array): RelayKey {
  if (verifyingKey.length !== 32) {
    throw new TypeError("A relay's verifying key must be 32 bytes")
  }
  return uint8ArrayToHex(verifyingKey) as RelayKey
}

export function relayKeyBytes(key: RelayKey): Uint8Array {
  return hexToUint8Array(key)
}
