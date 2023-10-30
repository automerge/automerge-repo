import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "crypto"

const ALGORITHM = "aes-256-gcm"

export function encrypt(payload: Uint8Array, pw: string): Uint8Array {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = getKeyFromPassword(pw, salt)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(payload)),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()

  return Buffer.concat([salt, iv, tag, encrypted])
}

export function decrypt(encrypted: Uint8Array, pw: string): Uint8Array {
  const salt = encrypted.slice(0, 16)
  const iv = encrypted.slice(16, 28)
  const tag = encrypted.slice(28, 44)
  const data = encrypted.slice(44)

  const key = getKeyFromPassword(pw, salt)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)

  // this will throw if the password is wrong
  return Buffer.concat([decipher.update(data), decipher.final()])
}

function getKeyFromPassword(pw: string, salt: Uint8Array): Uint8Array {
  const pwBytes = new TextEncoder().encode(pw)

  // note: for this to actually be secure, you would want to use a deliberately
  // slow key derivation function like scrypt - for example:

  // return scryptSync(pwBytes, salt, 32)

  // As this is just used for testing, we'll use a hash function instead to keep things fast.

  const hash = createHash("sha256")
  hash.update(Buffer.concat([pwBytes, salt]))
  return hash.digest()
}
