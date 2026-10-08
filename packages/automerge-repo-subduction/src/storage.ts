import * as N from "@automerge/subduction/slim"
import {
  decodeRecordFrame,
  encodeRecordFrame,
  fragmentPayloadDigest,
} from "./recordFrame.js"
import {
  BackendError,
  checkpointId,
  commitId,
  copyRecord,
  equalRecords,
  idBytes,
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
  /** Every entry whose key begins with `prefix`, sorted by key, from one
   * consistent read (like main's StorageAdapter.loadRange). Returned bytes are
   * owned by the caller. */
  loadPrefix(prefix: string): Promise<[key: string, data: Uint8Array][]>
}

/** Per-record bound only. Total history per tree is not capped: a store that
 * accepted writes must always be able to read, sync and delete them again. */
export interface ReadLimits {
  maxRecordBytes: number
}

const ROOT = "subduction-v1/"
export const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")
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

/** Commits are keyed by ID. Fragments are keyed by head plus the digest of
 * their unsigned payload, like native storage, so valid same-head variants
 * coexist and sort in native's tie-break order. */
type RecordKey =
  | { kind: "commit"; key: string }
  | { kind: "fragment"; key: string; variant: string }

const kindPrefix = (tree: string, kind: Kind) =>
  `${prefix(tree)}${kind === "commit" ? "commits" : "fragments"}/`
const recordPath = (tree: string, ref: RecordKey) =>
  `${kindPrefix(tree, ref.kind)}${ref.key}${ref.kind === "fragment" ? `.${ref.variant}` : ""}`

/** Parse a key relative to its tree prefix; the tree marker is `undefined`. */
function parseRecordKey(relative: string): RecordKey | undefined {
  if (relative === "id") return undefined
  const match =
    /^(?:commits\/([0-9a-f]{64})|fragments\/([0-9a-f]{64})\.([0-9a-f]{64}))$/.exec(
      relative
    )
  if (!match) throw new Error("Malformed storage key")
  return match[1]
    ? { kind: "commit", key: match[1] }
    : { kind: "fragment", key: match[2], variant: match[3] }
}

/** Native unsigned commit for a local write, from a Repo record. */
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

/** Record fields from a signed commit's payload. Performs no checks: on write,
 * native has already verified the blob and derived the key from this payload;
 * on read, the envelope checksum and Repo's record validation cover it. */
function plain(
  signed: N.SignedLooseCommit,
  blob: Uint8Array,
  tree?: N.SedimentreeId
): LooseCommitRecord {
  const payload = signed.payload
  const head = payload.commitId
  const parents = payload.parents
  try {
    if (tree) assertCommitTree(tree, head, parents, payload)
    return copyRecord({
      kind: "commit",
      id: commitId(head.toHexString()),
      parents: parents.map(p => commitId(p.toHexString())),
      blob,
    }) as LooseCommitRecord
  } finally {
    head.free()
    parents.forEach(p => p.free())
    payload.free()
  }
}

/** Incoming records are signed by remote peers, and native saves them under
 * the requested tree without checking that the signed payload names that tree.
 * The JS commit payload has no tree accessor, so rebuild it with ours (every
 * other field taken from the payload) and compare digests.
 * This would be better handled natively, as a payload `sedimentree_id` check
 * after `try_verify` in subduction_core's `recv_commit`/`recv_fragment`
 * (handler/sync.rs) and `recv_batch_sync_response` (subduction/ingest.rs),
 * dropping the record there. It could then be removed here. */
function assertCommitTree(
  tree: N.SedimentreeId,
  head: N.CommitId,
  parents: N.CommitId[],
  payload: N.LooseCommit
): void {
  const meta = payload.blobMeta
  const rebuilt = new N.LooseCommit(tree, head, parents, meta)
  const expected = rebuilt.digest
  const actual = payload.digest
  try {
    if (expected.toHexString() !== actual.toHexString())
      throw new Error("Signed commit is for a different tree")
  } finally {
    expected.free()
    actual.free()
    rebuilt.free()
    meta.free()
  }
}

/** Record fields from a signed fragment's payload; checks only the tree when
 * given (see assertCommitTree for why, and where it belongs natively). */
function plainFragment(
  signed: N.SignedFragment,
  blob: Uint8Array,
  tree?: string
): FragmentRecord {
  const payload = signed.payload
  const id = payload.sedimentreeId
  const head = payload.head
  const boundary = payload.boundary
  const checkpoints = payload.checkpoints
  try {
    if (tree !== undefined && treeHex(id) !== tree)
      throw new Error("Signed fragment is for a different tree")
    return copyRecord({
      kind: "fragment",
      head: commitId(head.toHexString()),
      boundary: boundary.map(b => commitId(b.toHexString())),
      checkpoints: checkpoints.map(c => checkpointId(hex(c.toBytes()))),
      blob,
    }) as FragmentRecord
  } finally {
    checkpoints.forEach(c => c.free())
    boundary.forEach(b => b.free())
    head.free()
    id.free()
    payload.free()
  }
}

type Stored =
  | { kind: "commit"; signed: N.SignedLooseCommit; record: LooseCommitRecord }
  | {
      kind: "fragment"
      signed: N.SignedFragment
      record: FragmentRecord
      variant: string
    }

interface Prepared {
  tree: string
  sid: SedimentreeId
  ref: RecordKey
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
    if (keys.some(k => !k.startsWith(p)))
      throw new Error("Storage returned an out-of-prefix key")
    return [...new Set(keys)].sort()
  }

  private async read(
    tree: string,
    ref: RecordKey
  ): Promise<Stored | undefined> {
    const value = await this.storage.load(recordPath(tree, ref))
    return value === undefined
      ? undefined
      : this.decode(idBytes(sedimentreeId(tree)), ref, value)
  }

  /** The variant native would keep for this head: keys sort by payload
   * digest, so take the first rather than relying on store enumeration. */
  private async readFragment(
    tree: string,
    head: string
  ): Promise<Extract<Stored, { kind: "fragment" }> | undefined> {
    const variants = this.decodeAll(
      tree,
      await this.storage.loadPrefix(`${kindPrefix(tree, "fragment")}${head}.`)
    )
    let first: Extract<Stored, { kind: "fragment" }> | undefined
    for (const value of variants) {
      if (
        value.kind === "fragment" &&
        (!first || value.variant < first.variant)
      ) {
        first?.signed.free()
        first = value
      } else value.signed.free()
    }
    return first
  }

  /** Validate and decode one stored compound record. Every read path, single
   * key or bulk, goes through here so the checks are identical. */
  private decode(
    treeBytes: Uint8Array,
    ref: RecordKey,
    value: Uint8Array
  ): Stored {
    const { encoded, blob } = decodeRecordFrame(
      treeBytes,
      ref.kind,
      ref.key,
      value,
      this.limits.maxRecordBytes
    )
    // Tree, key and blob were checked when written; the frame checksum and
    // Repo's record validation cover damage since.
    if (ref.kind === "fragment") {
      if (ref.variant !== hex(fragmentPayloadDigest(encoded)))
        throw new Error("Fragment key does not match its signed payload")
      const signed = N.SignedFragment.tryDecode(encoded)
      try {
        return {
          kind: "fragment",
          signed,
          record: plainFragment(signed, blob),
          variant: ref.variant,
        }
      } catch (error) {
        signed.free()
        throw error
      }
    }
    const signed = N.SignedLooseCommit.tryDecode(encoded)
    try {
      return { kind: "commit", signed, record: plain(signed, blob) }
    } catch (error) {
      signed.free()
      throw error
    }
  }

  private async recordKeys(tree: string): Promise<RecordKey[]> {
    const p = prefix(tree)
    return (await this.keys(p)).flatMap(key => {
      const ref = parseRecordKey(key.slice(p.length))
      return ref ? [ref] : []
    })
  }

  /** One validated read of BOTH kinds and the marker, from a single
   * `loadPrefix` (one storage transaction) rather than a list plus a load per
   * record. Every record is validated exactly as a single-key read would be. */
  private async snapshot(tree: string): Promise<Stored[]> {
    return this.decodeAll(tree, await this.storage.loadPrefix(prefix(tree)))
  }

  /** One kind only, for native hydration's per-kind calls. Native always asks
   * for both kinds, so corruption in either still fails hydration. */
  private async kindSnapshot(tree: string, kind: Kind): Promise<Stored[]> {
    return this.decodeAll(
      tree,
      await this.storage.loadPrefix(kindPrefix(tree, kind))
    )
  }

  private decodeAll(tree: string, entries: [string, Uint8Array][]): Stored[] {
    const p = prefix(tree)
    const treeBytes = idBytes(sedimentreeId(tree))
    const values: Stored[] = []
    try {
      for (const [fullKey, value] of entries) {
        if (!fullKey.startsWith(p))
          throw new Error("Storage returned an out-of-prefix key")
        const ref = parseRecordKey(fullKey.slice(p.length))
        if (!ref) {
          if (value.length !== 1 || value[0] !== 1)
            throw new Error("Malformed tree marker")
          continue
        }
        values.push(this.decode(treeBytes, ref, value))
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

  /** Stored commits with these IDs (undefined where absent). One key read
   * each; never a tree scan. Serialized like other reads. */
  lookupCommits(
    id: N.SedimentreeId,
    commits: readonly LooseCommitRecord[]
  ): Promise<(SedimentreeRecord | undefined)[]> {
    const tree = treeHex(id)
    const ids = commits.map(commit => commit.id)
    return this.enqueue(async () => {
      const found: (SedimentreeRecord | undefined)[] = []
      for (const key of ids) {
        const value = await this.read(tree, { kind: "commit", key })
        value?.signed.free()
        found.push(value?.record)
      }
      return found
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
      const match = /^([0-9a-f]{64})\/(.*)$/s.exec(key.slice(ROOT.length))
      if (!match) throw new Error("Malformed storage key")
      parseRecordKey(match[2])
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
    const record = plain(signed, blob, id)
    return this.prepare(id, cid, key.toBytes(), record, signed.encode())
  }
  private prepareFragment(
    id: N.SedimentreeId,
    key: N.CommitId,
    signed: N.SignedFragment,
    blob: Uint8Array
  ): Prepared {
    const head = key.toHexString()
    const record = plainFragment(signed, blob, treeHex(id))
    return this.prepare(id, head, key.toBytes(), record, signed.encode())
  }
  private prepare(
    id: N.SedimentreeId,
    key: string,
    keyBytes: Uint8Array,
    record: SedimentreeRecord,
    encoded: Uint8Array
  ): Prepared {
    if (encoded.length + record.blob.length > this.limits.maxRecordBytes)
      throw new Error("Record limit exceeded")
    if ((record.kind === "commit" ? record.id : record.head) !== key)
      throw new Error("Signed record key does not match storage key")
    const ref: RecordKey =
      record.kind === "commit"
        ? { kind: "commit", key }
        : {
            kind: "fragment",
            key,
            variant: hex(fragmentPayloadDigest(encoded)),
          }
    return {
      tree: treeHex(id),
      sid: logicalId(id),
      ref,
      record,
      frame: encodeRecordFrame(id.toBytes(), keyBytes, record, encoded),
    }
  }
  private async savePrepared(value: Prepared): Promise<void> {
    const { tree, sid, ref, record, frame } = value
    // Same-key lookup only: whole-history budgets are enforced on reads.
    const existing = await this.read(tree, ref)
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
    await this.storage.save(recordPath(tree, ref), frame)
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
      const value = await this.read(tree, { kind: "commit", key: cid })
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
    const values = await this.kindSnapshot(tree, "commit")
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
      const path = recordPath(tree, { kind: "commit", key: key.toHexString() })
      return () => this.storage.remove(path)
    })
  }
  async deleteAllCommits(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.removeKeys(kindPrefix(tree, "commit"))
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
      const value = await this.readFragment(tree, head)
      // FragmentWithBlob consumes signed too.
      return value
        ? new N.FragmentWithBlob(value.signed, value.record.blob)
        : null
    })
  }
  async listFragmentIds(id: N.SedimentreeId): Promise<N.CommitId[]> {
    const tree = treeHex(id)
    return this.enqueue(async () =>
      [
        ...new Set(
          (await this.recordsFor(tree))
            .filter((r): r is FragmentRecord => r.kind === "fragment")
            .map(r => r.head)
        ),
      ].map(head => N.CommitId.fromHexString(head))
    )
  }
  async loadAllFragments(id: N.SedimentreeId): Promise<N.FragmentWithBlob[]> {
    const tree = treeHex(id)
    return this.enqueue(() => this.loadFragments(tree))
  }
  private async loadFragments(tree: string): Promise<N.FragmentWithBlob[]> {
    const values = await this.kindSnapshot(tree, "fragment")
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
    // Like native, a head-only delete removes every variant of that head.
    return this.mutate(id, tree => {
      const variants = `${kindPrefix(tree, "fragment")}${key.toHexString()}.`
      return () => this.removeKeys(variants)
    })
  }
  async deleteAllFragments(id: N.SedimentreeId): Promise<void> {
    return this.mutate(
      id,
      tree => () => this.removeKeys(kindPrefix(tree, "fragment"))
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
