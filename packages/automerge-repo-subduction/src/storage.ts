import type * as N from "@automerge/subduction/slim"
import type { ByteStore } from "./ByteStore.js"
import {
  sedimentreeId,
  type SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"

const ROOT = "subduction-v2/"
const IDS = `${ROOT}ids/`

/** Repo IDs may be 16 bytes; native IDs are always 32, zero-padded. */
export function nativeId(id: SedimentreeId): N.SedimentreeId {
  return sedimentreeId(id).padEnd(64, "0")
}
export function logicalId(id: N.SedimentreeId): SedimentreeId {
  return sedimentreeId(id.endsWith("0".repeat(32)) ? id.slice(0, 32) : id)
}

type Kind = "commits" | "fragments"
type Part = "signed" | "blob"
const kindPrefix = (tree: string, kind: Kind) => `${ROOT}trees/${tree}/${kind}/`
const partPrefix = (tree: string, kind: Kind, part: Part) =>
  `${kindPrefix(tree, kind)}${part}/`
const recordKeys = (tree: string, kind: Kind, head: string) => [
  `${partPrefix(tree, kind, "signed")}${head}`,
  `${partPrefix(tree, kind, "blob")}${head}`,
]
type Entry = [key: string, data: Uint8Array]
const recordEntries = (
  tree: string,
  kind: Kind,
  head: string,
  signed: Uint8Array,
  blob: Uint8Array
): Entry[] => {
  const [signedKey, blobKey] = recordKeys(tree, kind, head)
  return [
    [signedKey, signed],
    [blobKey, blob],
  ]
}
const EMPTY = new Uint8Array(0)

/** Subduction's storage callbacks over a ByteStore. Stores exactly what
 * Subduction sends, keyed by tree and head; Subduction verifies on admission
 * and checks blob agreement on load. Each record is a signed/blob key pair,
 * written atomically by `saveBatch`.
 */
export class StorageBridge implements N.SedimentreeStorage {
  constructor(private readonly storage: ByteStore) {}

  private async loadRecord(
    tree: string,
    kind: Kind,
    head: string
  ): Promise<N.StoredCommit | null> {
    const [signed, blob] = await this.storage.loadMany(
      recordKeys(tree, kind, head)
    )
    if (signed === undefined && blob === undefined) return null
    if (signed === undefined || blob === undefined)
      throw new Error("Incomplete stored record")
    return { signed, blob }
  }

  private async listHeads(tree: string, kind: Kind): Promise<string[]> {
    const prefix = partPrefix(tree, kind, "signed")
    return (await this.storage.list(prefix)).map(key =>
      key.slice(prefix.length)
    )
  }

  private async loadAll(tree: string, kind: Kind): Promise<N.StoredCommit[]> {
    const signedPrefix = partPrefix(tree, kind, "signed")
    const blobPrefix = partPrefix(tree, kind, "blob")
    const records = new Map<string, Partial<N.StoredCommit>>()
    for (const [key, value] of await this.storage.loadPrefix(
      kindPrefix(tree, kind)
    )) {
      const part = key.startsWith(signedPrefix)
        ? "signed"
        : key.startsWith(blobPrefix)
          ? "blob"
          : undefined
      if (!part) throw new Error("Malformed storage key")
      const head = key.slice(
        (part === "signed" ? signedPrefix : blobPrefix).length
      )
      const record = records.get(head) ?? {}
      record[part] = value
      records.set(head, record)
    }
    return [...records.values()].map(({ signed, blob }) => {
      if (signed === undefined || blob === undefined)
        throw new Error("Incomplete stored record")
      return { signed, blob }
    })
  }

  private removeRecord(tree: string, kind: Kind, head: string) {
    return this.storage.removeBatch(recordKeys(tree, kind, head))
  }

  async saveSedimentreeId(tree: N.SedimentreeId): Promise<void> {
    await this.storage.save(`${IDS}${tree}`, EMPTY)
  }
  async deleteSedimentreeId(tree: N.SedimentreeId): Promise<void> {
    await this.storage.remove(`${IDS}${tree}`)
  }
  async loadAllSedimentreeIds(): Promise<N.SedimentreeId[]> {
    return (await this.storage.list(IDS)).map(key => key.slice(IDS.length))
  }
  async containsSedimentreeId(tree: N.SedimentreeId): Promise<boolean> {
    return (await this.storage.load(`${IDS}${tree}`)) !== undefined
  }

  async saveCommit(
    tree: N.SedimentreeId,
    head: N.CommitId,
    signed: Uint8Array,
    blob: Uint8Array
  ): Promise<void> {
    await this.storage.saveBatch(
      recordEntries(tree, "commits", head, signed, blob)
    )
  }
  loadCommit(tree: N.SedimentreeId, head: N.CommitId) {
    return this.loadRecord(tree, "commits", head)
  }
  listCommitIds(tree: N.SedimentreeId) {
    return this.listHeads(tree, "commits")
  }
  loadAllCommits(tree: N.SedimentreeId) {
    return this.loadAll(tree, "commits")
  }
  deleteCommit(tree: N.SedimentreeId, head: N.CommitId) {
    return this.removeRecord(tree, "commits", head)
  }
  deleteAllCommits(tree: N.SedimentreeId) {
    return this.storage.removeRange(kindPrefix(tree, "commits"))
  }

  async saveFragment(
    tree: N.SedimentreeId,
    head: N.CommitId,
    signed: Uint8Array,
    blob: Uint8Array
  ): Promise<void> {
    await this.storage.saveBatch(
      recordEntries(tree, "fragments", head, signed, blob)
    )
  }
  loadFragment(tree: N.SedimentreeId, head: N.CommitId) {
    return this.loadRecord(tree, "fragments", head)
  }
  listFragmentIds(tree: N.SedimentreeId) {
    return this.listHeads(tree, "fragments")
  }
  loadAllFragments(tree: N.SedimentreeId) {
    return this.loadAll(tree, "fragments")
  }
  deleteFragment(tree: N.SedimentreeId, head: N.CommitId) {
    return this.removeRecord(tree, "fragments", head)
  }
  deleteAllFragments(tree: N.SedimentreeId) {
    return this.storage.removeRange(kindPrefix(tree, "fragments"))
  }

  async saveBatchAll(
    tree: N.SedimentreeId,
    commits: Parameters<N.SedimentreeStorage["saveBatchAll"]>[1],
    fragments: Parameters<N.SedimentreeStorage["saveBatchAll"]>[2]
  ): Promise<number> {
    await this.storage.saveBatch([
      ...commits.flatMap(c =>
        recordEntries(tree, "commits", c.commitId, c.signedCommit, c.blob)
      ),
      ...fragments.flatMap(f =>
        recordEntries(
          tree,
          "fragments",
          f.fragmentHead,
          f.signedFragment,
          f.blob
        )
      ),
    ])
    return commits.length + fragments.length
  }
}
