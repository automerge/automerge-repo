export const uint8ArrayFromHexString = (hexString: string): Uint8Array => {
  if (hexString.length % 2 !== 0) {
    throw new Error("Hex string must have an even length")
  }
  const bytes = new Uint8Array(hexString.length / 2)
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i >> 1] = parseInt(hexString.slice(i, i + 2), 16)
  }
  return bytes
}

export const uint8ArrayToHexString = (data: Uint8Array): string => {
  return Array.from(data, byte => byte.toString(16).padStart(2, "0")).join("")
}
