import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  commitId,
  copyRecord,
  equalRecords,
  idBytes,
  sedimentreeId,
  type LooseCommitRecord,
  type SedimentreeId,
} from "@automerge/automerge-repo-sedimentree"

/** Exclusively owned namespace. save MUST atomically replace one whole value.
 * list returns full keys beginning with prefix; missing load returns undefined.
 * Implementations must not mutate passed bytes. No batch atomicity is required.
 */
export interface LocalByteStore {
  load(key: string): Promise<Uint8Array | undefined>
  save(key: string, data: Uint8Array): Promise<void>
  remove(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

export interface ReadLimits {
  maxRecordBytes: number
  maxSnapshotBytes: number
  maxRecords: number
}

const ROOT = "subduction-v1/"
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
function digest(bytes: Uint8Array): string {
  const meta = new N.BlobMeta(bytes)
  const hash = meta.digest()
  try {
    return hash.toHexString()
  } finally {
    hash.free()
    meta.free()
  }
}
function bytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/.test(value))
    throw new Error("Invalid encoded bytes")
  return Uint8Array.from(value.match(/../g)!, b => parseInt(b, 16))
}
export function nativeId(id: SedimentreeId): N.SedimentreeId {
  return N.SedimentreeId.fromBytes(
    idBytes(sedimentreeId(id).padEnd(64, "0") as SedimentreeId)
  )
}
export function logicalId(id: N.SedimentreeId): SedimentreeId {
  const value = hex(id.toBytes())
  return sedimentreeId(
    value.endsWith("0".repeat(32)) ? value.slice(0, 32) : value
  )
}
const treeHex = (id: N.SedimentreeId) => hex(id.toBytes())
const prefix = (id: N.SedimentreeId) => `${ROOT}${treeHex(id)}/`
const unsupported = () =>
  new BackendError(
    "open",
    "unsupported",
    "Fragment checkpoints are not exposed by @automerge/subduction 0.21.2's public API"
  )

/** Reconstructing the native commit digest checks the otherwise opaque tree ID,
 * the logical key, parents AND blob digest/size. No wire-format parser is used. */
export function unsigned(
  id: N.SedimentreeId,
  record: LooseCommitRecord
): N.LooseCommit {
  const head = N.CommitId.fromHexString(record.id)
  const parents = record.parents.map(p => N.CommitId.fromHexString(p))
  const meta = new N.BlobMeta(record.blob)
  try {
    return new N.LooseCommit(id, head, parents, meta)
  } finally {
    head.free()
    parents.forEach(p => p.free())
    meta.free()
  }
}
function plain(
  id: N.SedimentreeId,
  key: string,
  signed: N.SignedLooseCommit,
  blob: Uint8Array
): LooseCommitRecord {
  const payload = signed.payload
  const head = payload.commitId
  const parents = payload.parents
  try {
    const record = copyRecord({
      kind: "commit",
      id: commitId(head.toHexString()),
      parents: parents.map(p => commitId(p.toHexString())),
      blob,
    }) as LooseCommitRecord
    if (record.id !== key)
      throw new Error("Commit key does not match signed metadata")
    const reconstructed = unsigned(id, record)
    const expected = reconstructed.digest
    const actual = payload.digest
    try {
      if (expected.toHexString() !== actual.toHexString())
        throw new Error("Signed tree/metadata/blob mismatch")
    } finally {
      expected.free()
      actual.free()
      reconstructed.free()
    }
    return record
  } finally {
    head.free()
    parents.forEach(p => p.free())
    payload.free()
  }
}

/** Private authoritative compound-record bridge; never compacts history. */
export class StorageBridge implements N.SedimentreeStorage {
  constructor(
    private readonly storage: LocalByteStore,
    private readonly limits: ReadLimits,
    private readonly saved: (
      id: SedimentreeId,
      record: LooseCommitRecord
    ) => void
  ) {}

  private async keys(p: string): Promise<string[]> {
    const keys = await this.storage.list(p)
    if (keys.length > this.limits.maxRecords * 3)
      throw new Error("Storage enumeration limit exceeded")
    if (keys.some(k => !k.startsWith(p)))
      throw new Error("Storage returned an out-of-prefix key")
    return [...new Set(keys)].sort()
  }
  private async noFragments(id: N.SedimentreeId): Promise<void> {
    if ((await this.keys(`${prefix(id)}fragments/`)).length) throw unsupported()
  }
  private encode(
    id: N.SedimentreeId,
    key: string,
    signed: Uint8Array,
    blob: Uint8Array
  ): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        tree: treeHex(id),
        commit: key,
        signed: hex(signed),
        signedDigest: digest(signed),
        blob: hex(blob),
      })
    )
  }
  private async read(
    id: N.SedimentreeId,
    key: string
  ): Promise<
    { signed: N.SignedLooseCommit; record: LooseCommitRecord } | undefined
  > {
    const value = await this.storage.load(`${prefix(id)}commits/${key}`)
    if (value === undefined) return undefined
    if (value.byteLength > this.limits.maxRecordBytes * 4 + 4096)
      throw new Error("Compound record too large")
    const frame = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value)
    )
    if (frame.v !== 1 || frame.tree !== treeHex(id) || frame.commit !== key)
      throw new Error("Invalid compound record version/tree/key")
    const blob = bytes(frame.blob)
    const encoded = bytes(frame.signed)
    // Native hydration trusts stored signatures; detect damaged envelope bytes
    // too. This checksum is corruption detection, NOT signature authentication.
    if (digest(encoded) !== frame.signedDigest)
      throw new Error("Signed envelope checksum mismatch")
    if (blob.length + encoded.length > this.limits.maxRecordBytes)
      throw new Error("Record limit exceeded")
    const signed = N.SignedLooseCommit.tryDecode(encoded)
    try {
      return { signed, record: plain(id, key, signed, blob) }
    } catch (error) {
      signed.free()
      throw error
    }
  }
  async records(id: N.SedimentreeId): Promise<LooseCommitRecord[]> {
    await this.noFragments(id)
    const marker = await this.storage.load(`${prefix(id)}id`)
    if (marker !== undefined && (marker.length !== 1 || marker[0] !== 1))
      throw new Error("Malformed tree marker")
    const keys = await this.commitKeys(id)
    let size = 0
    const records: LooseCommitRecord[] = []
    for (const key of keys) {
      const value = await this.read(id, key)
      if (!value) throw new Error("Listed commit is missing")
      value.signed.free()
      size += value.record.blob.length + value.record.parents.length * 32 + 32
      if (size > this.limits.maxSnapshotBytes)
        throw new Error("Snapshot byte limit exceeded")
      records.push(value.record)
    }
    return records
  }
  private async commitKeys(id: N.SedimentreeId): Promise<string[]> {
    const p = `${prefix(id)}commits/`
    const keys = (await this.keys(p)).map(k => k.slice(p.length))
    if (
      keys.length > this.limits.maxRecords ||
      keys.some(k => !/^[0-9a-f]{64}$/.test(k))
    )
      throw new Error("Invalid commit key or record count limit exceeded")
    return keys
  }
  async saveSedimentreeId(id: N.SedimentreeId): Promise<void> {
    const key = `${prefix(id)}id`
    await this.storage.save(key, new Uint8Array([1]))
  }
  async deleteSedimentreeId(id: N.SedimentreeId): Promise<void> {
    await this.storage.remove(`${prefix(id)}id`)
  }
  async loadAllSedimentreeIds(): Promise<N.SedimentreeId[]> {
    const trees = new Set<string>()
    for (const key of await this.keys(ROOT)) {
      const match =
        /^([0-9a-f]{64})\/(id|commits\/[0-9a-f]{64}|fragments\/[0-9a-f]{64})$/.exec(
          key.slice(ROOT.length)
        )
      if (!match) throw new Error("Malformed storage key")
      trees.add(match[1])
    }
    const ids: N.SedimentreeId[] = []
    try {
      for (const tree of trees) {
        const id = N.SedimentreeId.fromBytes(bytes(tree))
        try {
          // A marker may precede a failed first save: it is not collection data.
          if ((await this.records(id)).length) ids.push(id)
          else id.free()
        } catch (error) {
          id.free()
          throw error
        }
      }
      return ids
    } catch (error) {
      ids.forEach(id => id.free())
      throw error
    }
  }
  async containsSedimentreeId(id: N.SedimentreeId): Promise<boolean> {
    await this.noFragments(id)
    return (await this.commitKeys(id)).length > 0
  }
  async saveCommit(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedLooseCommit,
    blob: Uint8Array
  ): Promise<void> {
    // Snapshot every native/JS input before yielding to caller-owned storage.
    const cid = key.toHexString()
    const record = plain(id, cid, signed, new Uint8Array(blob))
    const encoded = new Uint8Array(signed.encode())
    const frame = this.encode(id, cid, encoded, record.blob)
    if (encoded.length + record.blob.length > this.limits.maxRecordBytes)
      throw new Error("Record limit exceeded")
    const sid = logicalId(id)
    const path = `${prefix(id)}commits/${cid}`
    const old = await this.read(id, cid)
    if (old) {
      old.signed.free()
      if (!equalRecords(old.record, record))
        throw new BackendError(
          "store",
          "conflict",
          "Different representation for an existing commit key"
        )
      return
    }
    await this.storage.save(path, frame)
    this.saved(sid, record)
  }
  async loadCommit(
    id: N.SedimentreeId,
    key: N.CommitId
  ): Promise<N.CommitWithBlob | null> {
    const value = await this.read(id, key.toHexString())
    // CommitWithBlob consumes signed.
    return value ? new N.CommitWithBlob(value.signed, value.record.blob) : null
  }
  async listCommitIds(id: N.SedimentreeId): Promise<N.CommitId[]> {
    return (await this.commitKeys(id)).map(k => N.CommitId.fromHexString(k))
  }
  async loadAllCommits(id: N.SedimentreeId): Promise<N.CommitWithBlob[]> {
    // Bound total read size and validate before handing records to native hydration.
    await this.records(id)
    const result: N.CommitWithBlob[] = []
    try {
      for (const key of await this.commitKeys(id)) {
        const value = await this.read(id, key)
        if (!value) throw new Error("Listed commit is missing")
        result.push(new N.CommitWithBlob(value.signed, value.record.blob))
      }
      return result
    } catch (error) {
      result.forEach(c => c.free())
      throw error
    }
  }
  async deleteCommit(id: N.SedimentreeId, key: N.CommitId): Promise<void> {
    await this.storage.remove(`${prefix(id)}commits/${key.toHexString()}`)
  }
  async deleteAllCommits(id: N.SedimentreeId): Promise<void> {
    for (const key of await this.keys(`${prefix(id)}commits/`))
      await this.storage.remove(key)
  }
  async saveFragment(): Promise<void> {
    throw unsupported()
  }
  async loadFragment(id: N.SedimentreeId): Promise<N.FragmentWithBlob | null> {
    await this.noFragments(id)
    return null
  }
  async listFragmentIds(id: N.SedimentreeId): Promise<N.CommitId[]> {
    await this.noFragments(id)
    return []
  }
  async loadAllFragments(id: N.SedimentreeId): Promise<N.FragmentWithBlob[]> {
    await this.noFragments(id)
    return []
  }
  async deleteFragment(id: N.SedimentreeId): Promise<void> {
    await this.noFragments(id)
  }
  async deleteAllFragments(id: N.SedimentreeId): Promise<void> {
    await this.noFragments(id)
  }
  async saveBatchAll(
    id: N.SedimentreeId,
    commits: Parameters<N.SedimentreeStorage["saveBatchAll"]>[1],
    fragments: Parameters<N.SedimentreeStorage["saveBatchAll"]>[2]
  ): Promise<number> {
    if (fragments.length) throw unsupported()
    const copies = commits.map(c => ({
      key: c.commitId.toHexString(),
      signed: new Uint8Array(c.signedCommit.encode()),
      blob: new Uint8Array(c.blob),
    }))
    const sid = nativeId(logicalId(id))
    try {
      await this.saveSedimentreeId(sid)
      for (const c of copies) {
        const key = N.CommitId.fromHexString(c.key)
        const signed = N.SignedLooseCommit.tryDecode(c.signed)
        try {
          await this.saveCommit(sid, key, signed, c.blob)
        } finally {
          key.free()
          signed.free()
        }
      }
      return copies.length
    } finally {
      sid.free()
    }
  }
  async cleanup(id: N.SedimentreeId): Promise<void> {
    // Also clears phantom markers. Never silently erase unsupported fragments.
    await this.noFragments(id)
    for (const key of await this.keys(prefix(id)))
      await this.storage.remove(key)
  }
}
