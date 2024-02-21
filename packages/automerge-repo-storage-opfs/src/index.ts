/**
 * This module provides a storage adapter for OPFS.
 *
 * @packageDocumentation
 */

import { Chunk, StorageAdapter, StorageKey } from '@automerge/automerge-repo'

export class OPFSStorageAdapter extends StorageAdapter {
  private baseDirectory: string
  private baseDirectoryHandle: FileSystemDirectoryHandle

  constructor(baseDirectory: string = "automerge-repo-data") {
    super()
    this.baseDirectory = baseDirectory
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const fileName = getKey(key)
    await this.initialize()

    try {
      const fileHandle = await this.baseDirectoryHandle.getFileHandle(fileName)
      const file = await fileHandle.getFile()
      const arrayBuffer = await file.arrayBuffer()
      return new Uint8Array(arrayBuffer)
    } catch (error) {
      // don't throw if file not found
      if (error.name === "NotFoundError") return undefined
      throw error
    }
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const fileName = getKey(key)
    await this.initialize()

    const fileHandle = await this.baseDirectoryHandle.getFileHandle(fileName, { create: true })
    const fileWritable = await fileHandle.createWritable()
    await fileWritable.write(data)
    return fileWritable.close()
  }

  async remove(key: StorageKey): Promise<void> {
    const fileName = getKey(key)
    await this.initialize()

    try {
      return this.baseDirectoryHandle.removeEntry(fileName)
    } catch (error) {
      // don't throw if file not found
      if (error.name === "NotFoundError") return undefined
      throw error
    }
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const chunks: Chunk[] = []
    const prefix = getKey(keyPrefix)
    await this.initialize()

    for await (const [name] of this.baseDirectoryHandle) {
        if (name.startsWith(prefix)) {
            const fileHandle = await this.baseDirectoryHandle.getFileHandle(name)
            const file = await fileHandle.getFile()
            const arrayBuffer = await file.arrayBuffer()
            chunks.push({key: name.split("_"), data: new Uint8Array(arrayBuffer)})
        }
    }

    return chunks
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = getKey(keyPrefix)
    await this.initialize()

    for await (const [name] of this.baseDirectoryHandle) {
        if (name.startsWith(prefix)) {
            await this.baseDirectoryHandle.removeEntry(name)
        }
    }
  }

  private async initialize() {
    if(!this.baseDirectoryHandle) {
      const root = await navigator.storage.getDirectory()
      this.baseDirectoryHandle = await root.getDirectoryHandle(this.baseDirectory, { create: true })
    }
  }

}

const getKey = (key: StorageKey): string => key.join("_")
