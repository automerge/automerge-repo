/**
 * A `StorageAdapter` which stores data in the local filesystem
 *
 * @packageDocumentation
 */
import { StorageAdapter, type StorageKey } from "@automerge/automerge-repo"
import fs from "fs"
import path from "path"
import { rimraf } from "rimraf"

export class NodeFSStorageAdapter extends StorageAdapter {
  private baseDirectory: string
  private cache: { [key: string]: {storageKey: StorageKey, data: Uint8Array }} = {}

  /**
   * @param baseDirectory - The path to the directory to store data in. Defaults to "./automerge-repo-data".
   */
  constructor(baseDirectory: string = "automerge-repo-data") {
    super()
    this.baseDirectory = baseDirectory
  }

  async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
    const key = cacheKey(keyArray)
    if (this.cache[key]) {
      return this.cache[key].data
    }

    const filePath = this.getFilePath(keyArray)

    try {
      const fileContent = await fs.promises.readFile(filePath)
      return new Uint8Array(fileContent)
    } catch (error) {
      if (error.code === "ENOENT") {
        // file not found
        return undefined
      } else {
        throw error
      }
    }
  }

  async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
    const key = cacheKey(keyArray)
    this.cache[key] = {data: binary, storageKey: keyArray}

    const filePath = this.getFilePath(keyArray)
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
    await fs.promises.writeFile(filePath, binary)
  }

  async remove(keyArray: string[]): Promise<void> {
    const filePath = this.getFilePath(keyArray)

    try {
      await fs.promises.unlink(filePath)
    } catch (error) {
      if (error.code !== "ENOENT") {
        // only throw if error is not file not found
        throw error
      }
    }
  }

  async loadRange(keyPrefix: StorageKey): Promise<{data: Uint8Array, key: StorageKey}[]> {
    const dirPath = this.getFilePath(keyPrefix)
    const cacheKeyPrefixString = cacheKey(keyPrefix)

    // Get the list of all cached keys that match the prefix
    const cachedKeys: string[] = Object.keys(this.cache).filter(key =>
      key.startsWith(cacheKeyPrefixString)
    )

    // Read filenames from disk
    let diskFiles
    try {
      diskFiles = await fs.promises.readdir(dirPath, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") {
        // Directory not found, initialize as empty
        diskFiles = []
      } else {
        throw error
      }
    }

    const diskKeys: string[] = diskFiles
      .filter(file => file.isFile())
      .map(file =>
        this.getKey([
          path.relative(this.baseDirectory, path.join(dirPath, file.name)),
        ])
      )

    // Combine and deduplicate the lists of keys
    const allKeys = [...new Set([...cachedKeys, ...diskKeys])]

    // Load all files
    return Promise.all(allKeys.map(async keyString => {
        const key: StorageKey = keyString.split(path.sep)
        return {
            data: await this.load(key),
            key,
        }
    }))
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const dirPath = this.getFilePath(keyPrefix)

    // Warning: This method will recursively delete the directory and all its contents!
    // Be absolutely sure this is what you want.
    await rimraf(dirPath)
  }

  private getKey(key: StorageKey): string {
    return path.join(...key)
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

function cacheKey(key: StorageKey): string {
  return path.join(...key)
}
