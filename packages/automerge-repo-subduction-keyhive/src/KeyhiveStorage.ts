import type { SubductionStorageAdapterInterface } from "@automerge/automerge-repo-subduction"
import { Archive, type Keyhive } from "@keyhive/keyhive/slim"
import { freeAfter, uint8ArrayToHex } from "./utilities.js"

const ARCHIVE_KEY = "keyhive/archive"
const EVENTS_PREFIX = "keyhive/events/"
const PREKEY_SECRETS_KEY = "keyhive/prekey-secrets"
const SIGNING_KEY = "keyhive/signing-key"

/** Keyhive state in a storage adapter. */
export class KeyhiveStorage {
  constructor(private readonly adapter: SubductionStorageAdapterInterface) {}

  async saveEvents(events: readonly Uint8Array[]): Promise<void> {
    const entries = await Promise.all(
      events.map(async event => {
        const copy = new Uint8Array(event)
        const hash = await crypto.subtle.digest("SHA-256", copy)
        const name = uint8ArrayToHex(new Uint8Array(hash))
        return [`${EVENTS_PREFIX}${name}`, copy] as [string, Uint8Array]
      })
    )
    await this.adapter.saveBatch(entries)
  }

  async saveArchive(keyhive: Keyhive): Promise<void> {
    const bytes = await freeAfter(await keyhive.toArchive(), archive =>
      archive.toBytes()
    )
    await this.adapter.saveBatch([[ARCHIVE_KEY, bytes]])
  }

  async savePrekeySecrets(keyhive: Keyhive): Promise<void> {
    const bytes = await keyhive.exportPrekeySecrets()
    await this.adapter.saveBatch([[PREKEY_SECRETS_KEY, bytes]])
  }

  async loadPrekeySecrets(keyhive: Keyhive): Promise<void> {
    const [bytes] = await this.adapter.loadMany([PREKEY_SECRETS_KEY])
    if (bytes) await keyhive.importPrekeySecrets(bytes)
  }

  /**
   * This replica's 32-byte Ed25519 secret key. A new one is generated and
   * saved if there is none. It is stored unencrypted.
   */
  async loadOrCreateSigningKey(): Promise<Uint8Array> {
    const [stored] = await this.adapter.loadMany([SIGNING_KEY])
    if (stored) {
      if (stored.byteLength !== 32) {
        throw new TypeError("The stored signing key is not 32 bytes")
      }
      return stored
    }
    const key = crypto.getRandomValues(new Uint8Array(32))
    await this.adapter.saveBatch([[SIGNING_KEY, key]])
    return key
  }

  async loadArchive(): Promise<Archive | undefined> {
    const [bytes] = await this.adapter.loadMany([ARCHIVE_KEY])
    return bytes && new Archive(bytes)
  }

  /**
   * Ingest stored events, save the archive, then delete the events keyhive
   * applied. Returns whether there were events and the archive was saved.
   */
  async ingestEvents(keyhive: Keyhive): Promise<boolean> {
    const stored = await this.adapter.loadPrefix(EVENTS_PREFIX)
    if (stored.length === 0) return false
    const pending = new Set(
      (await keyhive.ingestEventsBytes(stored.map(([, bytes]) => bytes))).map(
        (bytes: Uint8Array) => uint8ArrayToHex(bytes)
      )
    )
    await this.saveArchive(keyhive)
    await this.adapter.removeBatch(
      stored
        .filter(([, bytes]) => !pending.has(uint8ArrayToHex(bytes)))
        .map(([key]) => key)
    )
    return true
  }
}
