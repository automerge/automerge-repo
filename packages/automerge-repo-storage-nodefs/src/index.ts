import { StorageAdapter } from "@automerge/automerge-repo"
import fs from "fs"
import path from "path"
import { rimraf } from "rimraf"

export class NodeFSStorageAdapter extends StorageAdapter {
  private baseDirectory: string
  private cache: { [key: string]: Uint8Array } = {}

  constructor(baseDirectory: string = "automerge-repo-data") {
    super()
    this.baseDirectory = baseDirectory
  }

  async load(keyArray: string[]): Promise<Uint8Array | undefined> {
    const key = this.getKey(keyArray)
    if (this.cache[key]) {
      return this.cache[key]
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

  async save(keyArray: string[], binary: Uint8Array): Promise<void> {
    const key = this.getKey(keyArray)
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
      if (error.code !== "ENOENT") {
        // only throw if error is not file not found
        throw error
      }
    }
  }

  async loadRange(keyPrefix: string[]): Promise<Uint8Array[]> {
    const dirPath = this.getFilePath(keyPrefix)
    const keyPrefixString = this.getKey(keyPrefix)

    // Get the list of all cached keys that match the prefix
    const cachedKeys = Object.keys(this.cache).filter(key =>
      key.startsWith(keyPrefixString)
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

    const diskKeys = diskFiles
      .filter(file => file.isFile())
      .map(file =>
        this.getKey([
          path.relative(this.baseDirectory, path.join(dirPath, file.name)),
        ])
      )

    // Combine and deduplicate the lists of keys
    const allKeys = [...new Set([...cachedKeys, ...diskKeys])]

    // Load all files
    return Promise.all(allKeys.map(key => this.load(key.split(path.sep))))
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const dirPath = this.getFilePath(keyPrefix)

    // Warning: This method will recursively delete the directory and all its contents!
    // Be absolutely sure this is what you want.
    await rimraf(dirPath)
  }

  private getKey(keyArray: string[]): string {
    return path.join(...keyArray)
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
