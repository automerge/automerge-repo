import * as N from "@automerge/subduction/slim"
import {
  BackendError,
  checkpointId,
  commitId,
  copyRecord,
  equalRecords,
  idBytes,
  recordBytes,
  sedimentreeId,
  type FragmentRecord,
  type LooseCommitRecord,
  type SedimentreeId,
  type SedimentreeRecord,
} from "@automerge/automerge-repo/sedimentree"

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
const prefix = (tree: string) => `${ROOT}${tree}/`
type Kind = SedimentreeRecord["kind"]
const recordPath = (tree: string, kind: Kind, key: string) =>
  `${prefix(tree)}${kind === "commit" ? "commits" : "fragments"}/${key}`

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

/** Preserve the actual 12-byte prefixes, including head/boundary prefixes.
 * The original Fragment constructor requires full IDs rather than prefixes. */
export function unsignedFragment(
  id: N.SedimentreeId,
  record: FragmentRecord
): N.Fragment {
  const head = N.CommitId.fromHexString(record.head)
  const boundary: N.CommitId[] = []
  const checkpoints: N.Checkpoint[] = []
  const meta = new N.BlobMeta(record.blob)
  try {
    for (const b of record.boundary) boundary.push(N.CommitId.fromHexString(b))
    for (const c of record.checkpoints)
      checkpoints.push(N.Checkpoint.fromBytes(idBytes(checkpointId(c))))
    return N.Fragment.fromCheckpointPrefixes(
      id,
      head,
      boundary,
      checkpoints,
      meta
    )
  } finally {
    head.free()
    boundary.forEach(b => b.free())
    checkpoints.forEach(c => c.free())
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

/** Only public payload accessors are used. Metadata comes from the signed
 * payload, not a sidecar; the tree/head and actual blob must agree with it.
 * This checks integrity, not signature authenticity or causal coverage. */
function plainFragment(
  tree: string,
  key: string,
  signed: N.SignedFragment,
  blob: Uint8Array
): FragmentRecord {
  const payload = signed.payload
  const id = payload.sedimentreeId
  const head = payload.head
  const boundary = payload.boundary
  const checkpoints = payload.checkpoints
  const meta = payload.blobMeta
  const hash = meta.digest()
  try {
    if (treeHex(id) !== tree || head.toHexString() !== key)
      throw new Error("Fragment tree/key does not match signed metadata")
    if (
      meta.sizeBytes !== BigInt(blob.length) ||
      hash.toHexString() !== digest(blob)
    )
      throw new Error("Signed fragment blob digest/size mismatch")
    return copyRecord({
      kind: "fragment",
      head: commitId(head.toHexString()),
      boundary: boundary.map(b => commitId(b.toHexString())),
      checkpoints: checkpoints.map(c => checkpointId(hex(c.toBytes()))),
      blob,
    }) as FragmentRecord
  } finally {
    hash.free()
    meta.free()
    checkpoints.forEach(c => c.free())
    boundary.forEach(b => b.free())
    head.free()
    id.free()
    payload.free()
  }
}

type Stored =
  | { kind: "commit"; signed: N.SignedLooseCommit; record: LooseCommitRecord }
  | { kind: "fragment"; signed: N.SignedFragment; record: FragmentRecord }

interface Prepared {
  tree: string
  sid: SedimentreeId
  key: string
  record: SedimentreeRecord
  frame: Uint8Array
}

/** Private authoritative compound-record bridge; never compacts history.
 * Native networking calls storage independently of the owner's local-work queue,
 * so every transaction (including reads) is serialized here as well.
 */
export class StorageBridge implements N.SedimentreeStorage {
  private tail: Promise<void> = Promise.resolve()
  private readonly attempts = new Set<{
    id: SedimentreeId
    work: Promise<unknown>
    settled: boolean
  }>()

  constructor(
    private readonly storage: LocalByteStore,
    private readonly limits: ReadLimits,
    private readonly saved: (
      id: SedimentreeId,
      record: SedimentreeRecord
    ) => void,
    private readonly failed?: (id: SedimentreeId, cause: unknown) => void
  ) {}

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const work = this.tail.then(run)
    this.tail = work.then(
      () => {},
      () => {}
    )
    return work
  }

  /** Preparation is synchronous and precedes queue reservation. Only owned JS
   * snapshots may be captured by the returned transaction, never native inputs.
   * Even preparation failures are accepted, reported and visible to flush.
   */
  private mutate<T>(
    id: N.SedimentreeId,
    prepare: (tree: string) => () => Promise<T>
  ): Promise<T> {
    const sid = logicalId(id)
    let run: () => Promise<T>
    try {
      run = prepare(treeHex(id))
    } catch (cause) {
      run = () => Promise.reject(cause)
    }
    const work = this.enqueue(async () => {
      try {
        return await run()
      } catch (cause) {
        // A notification must not mask the storage failure or poison the queue.
        try {
          this.failed?.(sid, cause)
        } catch {}
        throw cause
      }
    })
    const attempt = { id: sid, work, settled: false }
    this.attempts.add(attempt)
    void work.then(
      () => this.attempts.delete(attempt),
      () => {
        attempt.settled = true
      }
    )
    return work
  }

  /** Capture all already accepted operations, including reads. Failures still
   * reject their own operation and remain in the mutation ledger for flush.
   * The owner must fence late native calls before using this for shutdown.
   */
  drain(): Promise<void> {
    return this.tail
  }

  /** Capture pending/failed mutations only; later calls belong to a later
   * barrier. Wait for every captured attempt before reporting and clearing its
   * failures. Concurrent barriers can report the same captured failure.
   * settledOnly sweeps already-failed mutations after an owner-side barrier:
   * captured local jobs may enter native storage after that barrier was called,
   * but its cleanup must not wait for subsequently accepted native writes.
   */
  async flush(
    ids?: readonly SedimentreeId[],
    settledOnly = false
  ): Promise<void> {
    const filter = ids
      ? new Set(ids.map(id => sedimentreeId(id).padEnd(64, "0")))
      : undefined
    const captured = [...this.attempts].filter(
      a =>
        (!settledOnly || a.settled) &&
        (!filter || filter.has(a.id.padEnd(64, "0")))
    )
    const results = await Promise.allSettled(captured.map(a => a.work))
    captured.forEach(a => this.attempts.delete(a))
    const errors = results.flatMap(r =>
      r.status === "rejected" ? [r.reason] : []
    )
    if (errors.length)
      throw new AggregateError(errors, "Accepted bridge mutations failed")
  }

  private async keys(p: string): Promise<string[]> {
    const keys = await this.storage.list(p)
    if (keys.length > this.limits.maxRecords * 3)
      throw new Error("Storage enumeration limit exceeded")
    if (keys.some(k => !k.startsWith(p)))
      throw new Error("Storage returned an out-of-prefix key")
    return [...new Set(keys)].sort()
  }

  private encode(
    tree: string,
    record: SedimentreeRecord,
    signed: Uint8Array
  ): Uint8Array {
    return new TextEncoder().encode(
      JSON.stringify({
        v: 1,
        tree,
        // Keep the existing commit schema byte-for-byte compatible. Fragments
        // have an explicit kind/head and their own namespace, even at one head.
        ...(record.kind === "commit"
          ? { commit: record.id }
          : { kind: "fragment", head: record.head }),
        signed: hex(signed),
        signedDigest: digest(signed),
        blob: hex(record.blob),
      })
    )
  }

  private async read(
    tree: string,
    kind: Kind,
    key: string
  ): Promise<Stored | undefined> {
    const value = await this.storage.load(recordPath(tree, kind, key))
    if (value === undefined) return undefined
    if (value.byteLength > this.limits.maxRecordBytes * 4 + 4096)
      throw new Error("Compound record too large")
    const frame = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(value)
    )
    if (
      !frame ||
      frame.v !== 1 ||
      frame.tree !== tree ||
      (kind === "commit"
        ? frame.commit !== key ||
          frame.kind !== undefined ||
          frame.head !== undefined
        : frame.kind !== "fragment" ||
          frame.head !== key ||
          frame.commit !== undefined)
    )
      throw new Error("Invalid compound record version/tree/key/kind")
    const blob = bytes(frame.blob)
    const encoded = bytes(frame.signed)
    // Native hydration trusts stored signatures; detect damaged envelope bytes
    // too. This checksum is corruption detection, NOT signature authentication.
    if (digest(encoded) !== frame.signedDigest)
      throw new Error("Signed envelope checksum mismatch")
    if (blob.length + encoded.length > this.limits.maxRecordBytes)
      throw new Error("Record limit exceeded")
    if (kind === "fragment") {
      const signed = N.SignedFragment.tryDecode(encoded)
      try {
        return { kind, signed, record: plainFragment(tree, key, signed, blob) }
      } catch (error) {
        signed.free()
        throw error
      }
    }
    const signed = N.SignedLooseCommit.tryDecode(encoded)
    const id = N.SedimentreeId.fromBytes(bytes(tree))
    try {
      return { kind, signed, record: plain(id, key, signed, blob) }
    } catch (error) {
      signed.free()
      throw error
    } finally {
      id.free()
    }
  }

  private async recordKeys(
    tree: string
  ): Promise<{ kind: Kind; key: string }[]> {
    const p = prefix(tree)
    const records: { kind: Kind; key: string }[] = []
    for (const key of await this.keys(p)) {
      const relative = key.slice(p.length)
      if (relative === "id") continue
      const match = /^(commits|fragments)\/([0-9a-f]{64})$/.exec(relative)
      if (!match) throw new Error("Malformed storage key")
      records.push({
        kind: match[1] === "commits" ? "commit" : "fragment",
        key: match[2],
      })
    }
    if (records.length > this.limits.maxRecords)
      throw new Error("Record count limit exceeded")
    return records
  }

  /** One bounded, validated read of BOTH kinds. Hydration must not hide corrupt
   * fragments just because native asks for commits first (or vice versa). */
  private async snapshot(tree: string): Promise<Stored[]> {
    const marker = await this.storage.load(`${prefix(tree)}id`)
    if (marker !== undefined && (marker.length !== 1 || marker[0] !== 1))
      throw new Error("Malformed tree marker")
    const keys = await this.recordKeys(tree)
    let size = 0
    const values: Stored[] = []
    try {
      for (const { kind, key } of keys) {
        const value = await this.read(tree, kind, key)
        if (!value) throw new Error(`Listed ${kind} is missing`)
        values.push(value)
        size += recordBytes(value.record)
        if (size > this.limits.maxSnapshotBytes)
          throw new Error("Snapshot byte limit exceeded")
      }
      return values
    } catch (error) {
      values.forEach(v => v.signed.free())
      throw error
    }
  }

  async records(
    id: N.SedimentreeId,
    consume?: (records: SedimentreeRecord[]) => void
  ): Promise<SedimentreeRecord[]> {
    const tree = treeHex(id)
    return this.enqueue(async () => {
      const records = await this.recordsFor(tree)
      // Install the observation before another transaction can save/notify.
      consume?.(records)
      return records
    })
  }

  inventory(consume: (ids: SedimentreeId[]) => void): Promise<void> {
    return this.enqueue(async () => {
      const ids = await this.loadIds()
      try {
        consume(ids.map(logicalId))
      } finally {
        ids.forEach(id => id.free())
      }
    })
  }

  private async recordsFor(tree: string): Promise<SedimentreeRecord[]> {
    const values = await this.snapshot(tree)
    return values.map(v => {
      v.signed.free()
      return v.record
    })
  }

  async saveSedimentreeId(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.storage.save(`${prefix(tree)}id`, new Uint8Array([1]))
    )
  }
  async deleteSedimentreeId(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.storage.remove(`${prefix(tree)}id`)
    )
  }
  async loadAllSedimentreeIds(): Promise<N.SedimentreeId[]> {
    return this.enqueue(() => this.loadIds())
  }
  private async loadIds(): Promise<N.SedimentreeId[]> {
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
        const values = await this.snapshot(tree)
        values.forEach(v => v.signed.free())
        // A marker may precede a failed first save: it is not collection data.
        if (values.length) ids.push(N.SedimentreeId.fromBytes(bytes(tree)))
      }
      return ids
    } catch (error) {
      ids.forEach(id => id.free())
      throw error
    }
  }
  async containsSedimentreeId(id: N.SedimentreeId): Promise<boolean> {
    const tree = treeHex(id)
    // A marker alone (left by a failed first save) is not stored history.
    return this.enqueue(async () => (await this.recordKeys(tree)).length > 0)
  }

  /** No native wrapper or caller-owned buffer survives into asynchronous I/O. */
  private prepareCommit(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedLooseCommit,
    blob: Uint8Array
  ): Prepared {
    const cid = key.toHexString()
    const record = plain(id, cid, signed, new Uint8Array(blob))
    return this.prepare(id, cid, record, new Uint8Array(signed.encode()))
  }
  private prepareFragment(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedFragment,
    blob: Uint8Array
  ): Prepared {
    const head = key.toHexString()
    const record = plainFragment(
      treeHex(id),
      head,
      signed,
      new Uint8Array(blob)
    )
    return this.prepare(id, head, record, new Uint8Array(signed.encode()))
  }
  private prepare(
    id: N.SedimentreeId,
    key: string,
    record: SedimentreeRecord,
    encoded: Uint8Array
  ): Prepared {
    if (encoded.length + record.blob.length > this.limits.maxRecordBytes)
      throw new Error("Record limit exceeded")
    const tree = treeHex(id)
    return {
      tree,
      sid: logicalId(id),
      key,
      record,
      frame: this.encode(tree, record, encoded),
    }
  }
  private async savePrepared(value: Prepared): Promise<void> {
    const { tree, sid, key, record, frame } = value
    // Same-key lookup only: whole-history budgets are enforced on reads.
    const existing = await this.read(tree, record.kind, key)
    if (existing) {
      existing.signed.free()
      if (!equalRecords(existing.record, record))
        throw new BackendError(
          "store",
          "conflict",
          `Different representation for an existing ${record.kind} key`
        )
      // Another writer or an ambiguous save may have missed this notification.
      this.saved(sid, record)
      return
    }
    await this.storage.save(recordPath(tree, record.kind, key), frame)
    // Only resolved saves notify. Ambiguous failures are handled by the owner's
    // rescan/retry path; an already saved record notifies on retry.
    this.saved(sid, record)
  }

  async saveCommit(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedLooseCommit,
    blob: Uint8Array
  ): Promise<void> {
    return this.mutate(id, () => {
      const value = this.prepareCommit(id, key, signed, blob)
      return () => this.savePrepared(value)
    })
  }
  async loadCommit(
    id: N.SedimentreeId,
    key: N.CommitId
  ): Promise<N.CommitWithBlob | null> {
    const tree = treeHex(id),
      cid = key.toHexString()
    return this.enqueue(async () => {
      const value = await this.read(tree, "commit", cid)
      // CommitWithBlob consumes signed.
      return value?.kind === "commit"
        ? new N.CommitWithBlob(value.signed, value.record.blob)
        : null
    })
  }
  async listCommitIds(id: N.SedimentreeId): Promise<N.CommitId[]> {
    const tree = treeHex(id)
    return this.enqueue(async () =>
      (await this.recordsFor(tree))
        .filter((r): r is LooseCommitRecord => r.kind === "commit")
        .map(r => N.CommitId.fromHexString(r.id))
    )
  }
  async loadAllCommits(id: N.SedimentreeId): Promise<N.CommitWithBlob[]> {
    const tree = treeHex(id)
    return this.enqueue(() => this.loadCommits(tree))
  }
  private async loadCommits(tree: string): Promise<N.CommitWithBlob[]> {
    const values = await this.snapshot(tree)
    const result: N.CommitWithBlob[] = []
    let consumed = 0
    try {
      for (const value of values) {
        if (value.kind === "commit")
          result.push(new N.CommitWithBlob(value.signed, value.record.blob))
        else value.signed.free()
        consumed++
      }
      return result
    } catch (error) {
      values.slice(consumed).forEach(v => v.signed.free())
      result.forEach(c => c.free())
      throw error
    }
  }
  async deleteCommit(id: N.SedimentreeId, key: N.CommitId): Promise<void> {
    return this.mutate(id, tree => {
      const path = recordPath(tree, "commit", key.toHexString())
      return () => this.storage.remove(path)
    })
  }
  async deleteAllCommits(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.removeKeys(`${prefix(tree)}commits/`)
    )
  }

  async saveFragment(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedFragment,
    blob: Uint8Array
  ): Promise<void> {
    return this.mutate(id, () => {
      const value = this.prepareFragment(id, key, signed, blob)
      return () => this.savePrepared(value)
    })
  }
  async loadFragment(
    id: N.SedimentreeId,
    key: N.CommitId
  ): Promise<N.FragmentWithBlob | null> {
    const tree = treeHex(id),
      head = key.toHexString()
    return this.enqueue(async () => {
      const value = await this.read(tree, "fragment", head)
      // FragmentWithBlob consumes signed too.
      return value?.kind === "fragment"
        ? new N.FragmentWithBlob(value.signed, value.record.blob)
        : null
    })
  }
  async listFragmentIds(id: N.SedimentreeId): Promise<N.CommitId[]> {
    const tree = treeHex(id)
    return this.enqueue(async () =>
      (await this.recordsFor(tree))
        .filter((r): r is FragmentRecord => r.kind === "fragment")
        .map(r => N.CommitId.fromHexString(r.head))
    )
  }
  async loadAllFragments(id: N.SedimentreeId): Promise<N.FragmentWithBlob[]> {
    const tree = treeHex(id)
    return this.enqueue(() => this.loadFragments(tree))
  }
  private async loadFragments(tree: string): Promise<N.FragmentWithBlob[]> {
    const values = await this.snapshot(tree)
    const result: N.FragmentWithBlob[] = []
    let consumed = 0
    try {
      for (const value of values) {
        if (value.kind === "fragment")
          result.push(new N.FragmentWithBlob(value.signed, value.record.blob))
        else value.signed.free()
        consumed++
      }
      return result
    } catch (error) {
      values.slice(consumed).forEach(v => v.signed.free())
      result.forEach(f => f.free())
      throw error
    }
  }
  async deleteFragment(id: N.SedimentreeId, key: N.CommitId): Promise<void> {
    return this.mutate(id, tree => {
      const path = recordPath(tree, "fragment", key.toHexString())
      return () => this.storage.remove(path)
    })
  }
  async deleteAllFragments(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.removeKeys(`${prefix(tree)}fragments/`)
    )
  }
  async saveBatchAll(
    id: N.SedimentreeId,
    commits: Parameters<N.SedimentreeStorage["saveBatchAll"]>[1],
    fragments: Parameters<N.SedimentreeStorage["saveBatchAll"]>[2]
  ): Promise<number> {
    // Snapshot and validate ALL native metadata and JS bytes before the first
    // await, including the tree ID. Callers may immediately free/reuse inputs.
    return this.mutate(id, tree => {
      const copies = [
        ...commits.map(c =>
          this.prepareCommit(id, c.commitId, c.signedCommit, c.blob)
        ),
        ...fragments.map(f =>
          this.prepareFragment(id, f.fragmentHead, f.signedFragment, f.blob)
        ),
      ]
      return async () => {
        await this.storage.save(`${prefix(tree)}id`, new Uint8Array([1]))
        for (const value of copies) await this.savePrepared(value)
        return copies.length
      }
    })
  }
  async cleanup(id: N.SedimentreeId): Promise<void> {
    // Also clears phantom markers, with no compaction or coverage inference.
    return this.mutate(id, tree => () => this.removeKeys(prefix(tree)))
  }
  private async removeKeys(p: string): Promise<void> {
    for (const key of await this.keys(p)) await this.storage.remove(key)
  }
}
