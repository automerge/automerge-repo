/**
 * @packageDocumentation
 * A `StorageAdapter` which stores data in the local filesystem.
 *
 * ## Durability and atomicity
 *
 * Writes use the standard POSIX "write-to-temporary + fsync + rename"
 * pattern so that a reader or a crash never observes a half-written file:
 *
 *   1. The payload is written to `<target>.tmp.<pid>.<uuid>`.
 *   2. The temporary file is `fsync`ed so its bytes reach disk.
 *   3. `rename(2)` replaces the target atomically (POSIX) or via
 *      `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` (Windows NTFS).
 *   4. On POSIX, the parent directory is `fsync`ed so the rename itself
 *      is durable across a crash. Windows does not expose directory
 *      fsync from user-space Node; directory metadata durability falls
 *      back to the operating system's own guarantees.
 *
 * {@link NodeFSStorageAdapter.saveBatch | saveBatch} applies the same
 * pattern per entry — every individual write is atomic — but is not an
 * all-or-nothing transaction across the batch. A crash midway through a
 * `saveBatch` may leave a prefix of the entries applied. Consumers that
 * need cross-entry atomicity must order their writes so that any
 * partial prefix is still a valid state.
 */

import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { rimraf } from "rimraf"

const IS_POSIX = os.platform() !== "win32"

export class NodeFSStorageAdapter implements StorageAdapterInterface {
  private baseDirectory: string
  private cache: { [key: string]: Uint8Array } = {}

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
    this.cache[getKey(keyArray)] = binary

    const filePath = this.getFilePath(keyArray)
    const dir = path.dirname(filePath)

    await fs.promises.mkdir(dir, { recursive: true })
    await atomicWrite(filePath, binary)
    await fsyncDir(dir)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    if (entries.length === 0) return

    for (const [keyArray, binary] of entries) {
      this.cache[getKey(keyArray)] = binary
    }

    // Phase 1: ensure all target directories exist.
    const dirs = new Set<string>()

    for (const [keyArray] of entries) {
      dirs.add(path.dirname(this.getFilePath(keyArray)))
    }

    await Promise.all(
      Array.from(dirs).map(d => fs.promises.mkdir(d, { recursive: true }))
    )

    // Phase 2: atomic per-entry write (tmp + fsync + rename) in parallel.
    await Promise.all(
      entries.map(([keyArray, binary]) =>
        atomicWrite(this.getFilePath(keyArray), binary)
      )
    )

    // Phase 3: fsync each distinct parent directory once,
    // so the renames are durable. No-op on Windows.
    await Promise.all(Array.from(dirs).map(d => fsyncDir(d)))
  }

  async remove(keyArray: string[]): Promise<void> {
    delete this.cache[getKey(keyArray)]
    const filePath = this.getFilePath(keyArray)
    try {
      await fs.promises.unlink(filePath)
    } catch (error: any) {
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
    const diskKeys: string[] = diskFiles
      // Skip any in-flight temporary files from concurrent atomic writes.
      .filter((fileName: string) => !isTmpPath(fileName))
      .map((fileName: string) => {
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
    this.cachedKeys(keyPrefix).forEach(key => delete this.cache[key])

    // remove from disk
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

const TMP_SUFFIX = ".tmp."

const isTmpPath = (p: string): boolean => path.basename(p).includes(TMP_SUFFIX)

/**
 * Write `bytes` to `targetPath` atomically:
 *   1. write to a temporary sibling file
 *   2. fsync the temporary file
 *   3. rename over the target
 *
 * On POSIX, rename is atomic with respect to concurrent readers and a
 * crash. On Windows NTFS, `fs.promises.rename` uses
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` which is atomic for
 * concurrent readers; post-crash state on Windows depends on NTFS and
 * the OS flush policy.
 */
const atomicWrite = async (
  targetPath: string,
  bytes: Uint8Array
): Promise<void> => {
  const tmpPath = `${targetPath}${TMP_SUFFIX}${process.pid}.${crypto
    .randomUUID()
    .replace(/-/g, "")}`

  const fh = await fs.promises.open(tmpPath, "w")
  let wroteTmp = false
  try {
    await fh.writeFile(bytes)
    await fh.sync()
    wroteTmp = true
  } finally {
    // fh.close() can itself throw (e.g. EIO). Wrap it in its own
    // try/finally so the tmp-file cleanup below still runs — otherwise
    // a close failure would mask the original error AND leak a tmp
    // file. We log the close error at debug level but don't re-throw;
    // the outer writeFile/sync error (if any) is the signal the caller
    // cares about.
    try {
      await fh.close()
    } catch (closeErr) {
      console.debug(
        `[automerge-repo-storage-nodefs] fh.close() failed for ${tmpPath}:`,
        closeErr
      )
    }
    if (!wroteTmp) {
      // Best-effort cleanup if writeFile/sync threw. The caller is
      // about to see the outer writeFile/sync error; the cleanup
      // failure almost certainly shares the same underlying cause
      // (e.g. EIO on the same filesystem), so we don't surface it
      // through the thrown error. A stray tmp file is filtered out by
      // loadRange and is otherwise harmless. We log via console.debug
      // so persistent tmp-file buildup is diagnosable in the unusual
      // case the cleanup itself fails.
      try {
        await fs.promises.unlink(tmpPath)
      } catch (cleanupErr) {
        console.debug(
          `[automerge-repo-storage-nodefs] failed to clean up tmp file ${tmpPath}:`,
          cleanupErr
        )
      }
    }
  }

  try {
    await fs.promises.rename(tmpPath, targetPath)
  } catch (err) {
    // If the rename failed, the tmp file is still lying around. Same
    // best-effort cleanup semantics as above.
    try {
      await fs.promises.unlink(tmpPath)
    } catch (cleanupErr) {
      console.debug(
        `[automerge-repo-storage-nodefs] failed to clean up tmp file ${tmpPath}:`,
        cleanupErr
      )
    }
    throw err
  }
}

/**
 * `fsync` a directory so that recent `rename(2)` calls into it are
 * durable. POSIX only — opening a directory on Windows fails with
 * `EISDIR`, so we skip it and rely on the OS's native guarantees.
 */
const fsyncDir = async (dir: string): Promise<void> => {
  if (!IS_POSIX) return
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(dir, "r")
    await fh.sync()
  } catch (err: any) {
    // Some filesystems (tmpfs, certain network mounts) refuse fsync on
    // directories. Treat that as a best-effort guarantee rather than a
    // hard failure — the file fsync still gave us data durability.
    if (err.code !== "EISDIR" && err.code !== "EINVAL") throw err
  } finally {
    await fh?.close()
  }
}

/** returns all files in a directory, recursively  */
const walkdir = async (dirPath: string): Promise<string[]> => {
  try {
    const entries = await fs.promises.readdir(dirPath, {
      withFileTypes: true,
    })
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
