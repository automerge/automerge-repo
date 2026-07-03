/**
 * @packageDocumentation
 * A `StorageAdapter` which stores data in the local filesystem
 */

import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim"
import fs from "fs"
import path from "path"

export class NodeFSStorageAdapter implements StorageAdapterInterface {
  private baseDirectory: string
  private cache: { [key: string]: Uint8Array } = Object.create(null)
  private keyIndex: KeyTrieNode = { children: new Map(), key: null, seq: 0 }
  private keySeq = 0

  /**
   * @param baseDirectory - The path to the directory to store data in. Defaults to "./automerge-repo-data".
   */
  constructor(baseDirectory = "automerge-repo-data") {
    this.baseDirectory = baseDirectory
  }

  async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
    const key = getKey(keyArray)
    if (this.cache[key]) return this.cache[key]

    const filePath = this.getFilePath(keyArray)

    try {
      const fileContent = await fs.promises.readFile(filePath)
      return new Uint8Array(fileContent)
    } catch (error: any) {
      // don't throw if file not found
      if (error.code === "ENOENT") return undefined
      throw error
    }
  }

  async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
    const key = getKey(keyArray)
    this.cacheSet(key, binary)

    const filePath = this.getFilePath(keyArray)

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, binary)
  }

  async remove(keyArray: string[]): Promise<void> {
    // remove from cache
    this.cacheDelete(getKey(keyArray))
    // remove from disk
    const filePath = this.getFilePath(keyArray)
    try {
      await fs.promises.unlink(filePath)
    } catch (error: any) {
      // don't throw if file not found
      if (error.code !== "ENOENT") throw error
    }
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    /* This whole function does a bunch of gratuitious string manipulation
       and could probably be simplified. */

    const dirPath = this.getFilePath(keyPrefix)

    // Get the list of all cached keys that match the prefix
    const cachedKeys = this.cachedKeys(keyPrefix)

    // Read filenames from disk
    const diskFiles = await walkdir(dirPath)

    // The "keys" in the cache don't include the baseDirectory.
    // We want to de-dupe with the cached keys so we'll use getKey to normalize them.
    const diskKeys: string[] = diskFiles.map((fileName: string) => {
      const k = getKey([path.relative(this.baseDirectory, fileName)])
      return k.slice(0, 2) + k.slice(3)
    })

    // Combine and deduplicate the lists of keys
    const allKeys = [...new Set([...cachedKeys, ...diskKeys])]

    // Load all files
    const chunks = await Promise.all(
      allKeys.map(async keyString => {
        const key: StorageKey = keyString.split(path.sep)
        const data = await this.load(key)
        return { data, key }
      })
    )

    return chunks
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    // remove from cache
    this.cachedKeys(keyPrefix).forEach(key => this.cacheDelete(key))

    // remove from disk
    const dirPath = this.getFilePath(keyPrefix)
    await fs.promises.rm(dirPath, { recursive: true, force: true })
  }

  /** Set a cache entry, keeping the prefix index in sync. */
  private cacheSet(key: string, binary: Uint8Array): void {
    if (this.cache[key] === undefined)
      trieInsert(this.keyIndex, key, this.keySeq++)
    this.cache[key] = binary
  }

  /** Delete a cache entry, keeping the prefix index in sync. */
  private cacheDelete(key: string): void {
    if (this.cache[key] === undefined) return
    delete this.cache[key]
    trieDelete(this.keyIndex, key)
  }

  private cachedKeys(keyPrefix: string[]): string[] {
    return trieCollect(this.keyIndex, getKey(keyPrefix).split(path.sep))
  }

  private getFilePath(keyArray: string[]): string {
    const [firstKey, ...remainingKeys] = keyArray
    return path.join(
      this.baseDirectory,
      firstKey.slice(0, 2),
      firstKey.slice(2),
      ...remainingKeys
    )
  }
}

// HELPERS

const getKey = (key: StorageKey): string => path.join(...key)

/**
 * A trie over storage keys split on `path.sep`, used to answer
 * `loadRange` prefix queries in O(matches) rather than scanning every
 * cached key. Terminal nodes store the full key string so collection
 * returns exact keys without reconstruction.
 *
 * Segment-boundary matching (rather than raw string `startsWith`) mirrors
 * the on-disk `walkdir`, which is inherently directory-scoped; the two
 * sides of `loadRange` therefore agree.
 */
interface KeyTrieNode {
  children: Map<string, KeyTrieNode>
  key: string | null
  // Insertion sequence of `key`, so `trieCollect` can reproduce the
  // insertion-ordered results that the previous `Object.keys` scan gave
  // (and that the storage acceptance tests assert). Meaningless unless
  // `key !== null`.
  seq: number
}

const trieInsert = (root: KeyTrieNode, fullKey: string, seq: number): void => {
  let node = root
  for (const seg of fullKey.split(path.sep)) {
    let child = node.children.get(seg)
    if (child === undefined) {
      child = { children: new Map(), key: null, seq: 0 }
      node.children.set(seg, child)
    }
    node = child
  }
  node.key = fullKey
  node.seq = seq
}

const trieDelete = (root: KeyTrieNode, fullKey: string): void => {
  const segs = fullKey.split(path.sep)
  const nodes: KeyTrieNode[] = [root]
  let node = root
  for (const seg of segs) {
    const child = node.children.get(seg)
    if (child === undefined) return
    nodes.push(child)
    node = child
  }
  node.key = null
  // Prune now-empty nodes bottom-up so the index doesn't accumulate
  // dead interior nodes as keys come and go.
  for (let i = segs.length - 1; i >= 0; i--) {
    const child = nodes[i + 1]
    if (child.key !== null || child.children.size > 0) break
    nodes[i].children.delete(segs[i])
  }
}

const trieCollect = (root: KeyTrieNode, prefixSegs: string[]): string[] => {
  let node = root
  for (const seg of prefixSegs) {
    const child = node.children.get(seg)
    if (child === undefined) return []
    node = child
  }
  const found: Array<{ key: string; seq: number }> = []
  const stack: KeyTrieNode[] = [node]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (n.key !== null) found.push({ key: n.key, seq: n.seq })
    for (const child of n.children.values()) stack.push(child)
  }
  found.sort((a, b) => a.seq - b.seq)
  return found.map(f => f.key)
}

/** returns all files in a directory, recursively  */
const walkdir = async (dirPath: string): Promise<string[]> => {
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
    const files = await Promise.all(
      entries.map(entry => {
        const subpath = path.resolve(dirPath, entry.name)
        return entry.isDirectory() ? walkdir(subpath) : subpath
      })
    )
    return files.flat()
  } catch (error: any) {
    // don't throw if directory not found
    if (error.code === "ENOENT") return []
    throw error
  }
}
