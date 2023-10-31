/**
 * @packageDocumentation
 * A `StorageAdapter` which stores data in the local filesystem
 */

import { StorageAdapter, type StorageKey } from "@automerge/automerge-repo"
import fs from "fs"
import path from "path"
import { rimraf } from "rimraf"

export class NodeFSStorageAdapter extends StorageAdapter {
  private baseDirectory: string
  private cache: { [key: string]: Uint8Array } = {}

  /**
   * @param baseDirectory - The path to the directory to store data in. Defaults to "./automerge-repo-data".
   */
  constructor(baseDirectory: string = "automerge-repo-data") {
    super()
    this.baseDirectory = baseDirectory
  }

  async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
    const key = getKey(keyArray)
    if (this.cache[key]) return this.cache[key]

    const filePath = this.getFilePath(keyArray)

    try {
      const fileContent = await fs.promises.readFile(filePath)
      return new Uint8Array(fileContent)
    } catch (error) {
      // don't throw if file not found
      if (error.code === "ENOENT") return undefined
      throw error
    }
  }

  async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
    const key = getKey(keyArray)
    this.cache[key] = binary

    const filePath = this.getFilePath(keyArray)

    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, binary)
  }

  async remove(keyArray: string[]): Promise<void> {
    const filePath = this.getFilePath(keyArray)

    try {
      await fs.promises.unlink(filePath)
    } catch (error) {
      // don't throw if file not found
      if (error.code !== "ENOENT") throw error
    }
  }

  async loadRange(
    keyPrefix: StorageKey
  ): Promise<{ data: Uint8Array; key: StorageKey }[]> {
    /* This whole function does a bunch of gratuitious string manipulation
       and could probably be simplified. */

    const dirPath = this.getFilePath(keyPrefix)
    const cachedKeys = this.cachedKeys(keyPrefix)

    // Read filenames from disk
    const diskFiles = await walkdir(dirPath)

    // The "keys" in the cache don't include the baseDirectory.
    // We want to de-dupe with the cached keys so we'll use getKey to normalize them.
    const diskKeys: string[] = diskFiles.map((fileName: string) =>
      getKey([path.relative(this.baseDirectory, fileName)])
    )

    // Combine and deduplicate the lists of keys
    const allKeys = [...new Set([...cachedKeys, ...diskKeys])]

    // Load all files
    const result = await Promise.all(
      allKeys.map(async keyString => {
        const key: StorageKey = keyString.split(path.sep)
        const data = await this.load(key)
        return { data, key }
      })
    )

    return result
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const dirPath = this.getFilePath(keyPrefix)
    await rimraf(dirPath)
  }

  private cachedKeys(keyPrefix: string[]): string[] {
    const cacheKeyPrefixString = getKey(keyPrefix)
    return Object.keys(this.cache).filter(key =>
      key.startsWith(cacheKeyPrefixString)
    )
  }

  private getFilePath(keyArray: string[]): string {
    const [firstKey, ...remainingKeys] = keyArray
    const firstKeyDir = path.join(
      this.baseDirectory,
      firstKey.slice(0, 2),
      firstKey.slice(2)
    )

    return path.join(firstKeyDir, ...remainingKeys)
  }
}

// HELPERS

const getKey = (key: StorageKey): string => path.join(...key)

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
  } catch (error) {
    // don't throw if directory not found
    if (error.code === "ENOENT") return []
    throw error
  }
}
