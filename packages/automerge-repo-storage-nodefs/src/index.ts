/**
 * @packageDocumentation
 * A `StorageAdapter` which stores data in the local filesystem.
 *
 * ## Durability and atomicity
 *
 * Writes use the standard POSIX "write-to-temporary + fsync + rename"
 * pattern so that a reader or a crash never observes a half-written file:
 *
 *   1. The payload is written to `<baseDirectory>/.tmp/<pid>.<uuid>`.
 *   2. The temporary file is `fsync`ed so its bytes reach disk.
 *   3. `rename(2)` replaces the target atomically (POSIX) or via
 *      `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` (Windows NTFS).
 *   4. On POSIX, the parent directory is `fsync`ed so the rename itself
 *      is durable across a crash. Windows does not expose directory
 *      fsync from user-space Node; directory metadata durability falls
 *      back to the operating system's own guarantees.
 *
 * Temporary files live in a dedicated `<baseDirectory>/.tmp/` directory
 * rather than as siblings of their target files. This keeps them on the
 * same filesystem as their targets (required for atomic rename) while
 * making them invisible to older adapters and to {@link loadRange} /
 * {@link load}, which are always prefix-scoped and are unlikely to walk
 * `.tmp/` since real-world keys won't shard into a `.t` prefix.
 *
 * {@link NodeFSStorageAdapter.saveBatch | saveBatch} uses the same
 * pattern per entry, plus a two-phase stage/commit structure across
 * the batch:
 *
 *   1. Stage every entry's value to a tmp file (write + fsync). No
 *      target is yet observable.
 *   2. Commit by renaming every tmp file over its target.
 *   3. fsync every distinct parent directory once all renames have
 *      completed, so the renames themselves are durable across a crash.
 *
 * If any stage operation fails, no commits happen and the staged tmp
 * files are cleaned up. A crash during the commit phase may leave an
 * arbitrary subset of entries observable, but each individual
 * committed entry is atomic — readers never see partial bytes for any
 * single key.
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
  private tmpDirectory: string
  private tmpDirectoryReady: Promise<void> | undefined
  private cache: { [key: string]: Uint8Array } = {}

  /**
   * @param baseDirectory - The path to the directory to store data in. Defaults to "./automerge-repo-data".
   */
  constructor(baseDirectory = "automerge-repo-data") {
    this.baseDirectory = baseDirectory
    this.tmpDirectory = path.join(baseDirectory, TMP_DIR_NAME)
  }

  /**
   * Create `tmpDirectory` once (idempotent). Called lazily on the first
   * write so a read-only consumer of this adapter never creates the
   * `.tmp/` directory as a side effect of construction.
   */
  private ensureTmpDirectory(): Promise<void> {
    if (!this.tmpDirectoryReady) {
      this.tmpDirectoryReady = fs.promises
        .mkdir(this.tmpDirectory, { recursive: true })
        .then(() => undefined)
        .catch(err => {
          // Reset so subsequent writes retry the mkdir. Otherwise a
          // transient failure would be remembered forever.
          this.tmpDirectoryReady = undefined
          throw err
        })
    }
    return this.tmpDirectoryReady
  }

  /** Build a fresh unique path inside {@link tmpDirectory}. */
  private makeTmpPath(): string {
    return path.join(
      this.tmpDirectory,
      `${process.pid}.${crypto.randomUUID().replace(/-/g, "")}`
    )
  }

  async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
    const key = getKey(keyArray)
    if (this.cache[key]) return this.cache[key]

    const filePath = this.getFilePath(keyArray)

    try {
      const fileContent = await fs.promises.readFile(filePath)
      return new Uint8Array(fileContent)
    } catch (error: any) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return undefined
      }
      throw error
    }
  }

  async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
    // Rollback semantics: if the rename has not yet completed, on-disk
    // state is unchanged and we roll the cache back to match. Once the
    // rename completes, on-disk state is the new bytes (visible to
    // concurrent readers), so we do NOT roll back — cache matches disk.
    // A subsequent fsyncDir failure means the rename may not be durable
    // across a crash, but the bytes are still present and observable;
    // rolling back in that case would make cache diverge from disk.
    // The caller learns about the durability gap via the rejection.
    const key = getKey(keyArray)
    const prev = this.cache[key]
    this.cache[key] = binary

    const filePath = this.getFilePath(keyArray)
    const dir = path.dirname(filePath)

    try {
      await this.ensureTmpDirectory()
      await fs.promises.mkdir(dir, { recursive: true })
      await atomicWrite(filePath, this.makeTmpPath(), binary)
    } catch (err) {
      if (this.cache[key] === binary) {
        rollbackCache(this.cache, key, prev)
      }
      throw err
    }

    await fsyncDir(dir)
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    if (entries.length === 0) return

    const prevByKey: Array<[string, Uint8Array | undefined, Uint8Array]> = []
    for (const [keyArray, binary] of entries) {
      const key = getKey(keyArray)
      prevByKey.push([key, this.cache[key], binary])
      this.cache[key] = binary
    }

    const rollbackAllCache = () => {
      for (const [key, prev, ours] of prevByKey) {
        if (this.cache[key] === ours) {
          rollbackCache(this.cache, key, prev)
        }
      }
    }

    const rollbackCacheForIndices = (indices: number[]) => {
      for (const i of indices) {
        const [key, prev, ours] = prevByKey[i]
        if (this.cache[key] === ours) {
          rollbackCache(this.cache, key, prev)
        }
      }
    }

    // Ensure the tmp directory exists once for the whole batch.
    try {
      await this.ensureTmpDirectory()
    } catch (err) {
      rollbackAllCache()
      throw err
    }

    // Ensure every target's parent directory exists (deduped by
    // directory path). mkdir is `recursive: true`, idempotent.
    const targetDirs = new Set<string>()
    for (const [keyArray] of entries) {
      targetDirs.add(path.dirname(this.getFilePath(keyArray)))
    }
    try {
      await Promise.all(
        Array.from(targetDirs).map(d =>
          fs.promises.mkdir(d, { recursive: true })
        )
      )
    } catch (err) {
      rollbackAllCache()
      throw err
    }

    // ── Phase 1: Stage ─────────────────────────────────────────────
    const tmpPaths: string[] = entries.map(() => this.makeTmpPath())
    const targetPaths: string[] = entries.map(([keyArray]) =>
      this.getFilePath(keyArray)
    )

    const stageResults = await Promise.all(
      entries.map(([, binary], i) =>
        stageToTmp(tmpPaths[i], binary).then(
          () => ({ ok: true as const }),
          err => ({ ok: false as const, err })
        )
      )
    )

    const stageFailures: number[] = []
    let firstStageErr: unknown
    for (let i = 0; i < stageResults.length; i++) {
      const r = stageResults[i]
      if (!r.ok) {
        stageFailures.push(i)
        if (firstStageErr === undefined) firstStageErr = r.err
      }
    }

    if (stageFailures.length > 0) {
      await Promise.all(
        tmpPaths.map(async tmpPath => {
          try {
            await fs.promises.unlink(tmpPath)
          } catch (cleanupErr: any) {
            if (cleanupErr?.code === "ENOENT") return
            console.debug(
              `[automerge-repo-storage-nodefs] failed to clean up staged tmp file ${tmpPath}:`,
              cleanupErr
            )
          }
        })
      )
      rollbackAllCache()
      throw firstStageErr
    }

    // ── Phase 2: Commit ────────────────────────────────────────────
    const commitResults = await Promise.all(
      tmpPaths.map((tmpPath, i) =>
        fs.promises.rename(tmpPath, targetPaths[i]).then(
          () => ({ ok: true as const }),
          err => ({ ok: false as const, err })
        )
      )
    )

    const commitFailures: number[] = []
    let firstCommitErr: unknown
    for (let i = 0; i < commitResults.length; i++) {
      const r = commitResults[i]
      if (!r.ok) {
        commitFailures.push(i)
        if (firstCommitErr === undefined) firstCommitErr = r.err
      }
    }

    if (commitFailures.length > 0) {
      await Promise.all(
        commitFailures.map(async i => {
          try {
            await fs.promises.unlink(tmpPaths[i])
          } catch (cleanupErr) {
            console.debug(
              `[automerge-repo-storage-nodefs] failed to clean up staged tmp file ${tmpPaths[i]}:`,
              cleanupErr
            )
          }
        })
      )
      rollbackCacheForIndices(commitFailures)

      // fsync the parent directories of any entries whose rename
      // *did* succeed, so their renames are durable across a crash
      // even though we're about to throw. Otherwise a partial-commit
      // saveBatch leaves successful renames observable but not
      // durable, which is strictly weaker than a single save().
      const successDirs = new Set<string>()
      commitResults.forEach((r, i) => {
        if (r.ok) successDirs.add(path.dirname(targetPaths[i]))
      })
      const fsyncResults = await Promise.allSettled(
        Array.from(successDirs).map(d => fsyncDir(d))
      )
      fsyncResults.forEach(r => {
        if (r.status === "rejected") {
          console.debug(
            `[automerge-repo-storage-nodefs] fsyncDir failed during partial-commit recovery:`,
            r.reason
          )
        }
      })

      throw firstCommitErr
    }

    await Promise.all(Array.from(targetDirs).map(d => fsyncDir(d)))
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
    // We want to de-dupe with the cached keys so we'll use getKey to
    // normalize them. Tmp files live under <baseDirectory>/.tmp/, which
    // walkdir skips, so diskFiles never contains an in-flight tmp file.
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

/**
 * Restore a cache entry to its value prior to a failed write.
 *
 * If the key had no prior entry (`prev === undefined`), the entry is
 * deleted entirely. Otherwise it is overwritten with the prior bytes.
 * This keeps the in-memory cache consistent with on-disk state when
 * save() rejects partway through.
 */
const rollbackCache = (
  cache: Record<string, Uint8Array>,
  key: string,
  prev: Uint8Array | undefined
): void => {
  if (prev === undefined) {
    delete cache[key]
  } else {
    cache[key] = prev
  }
}

/**
 * Name of the subdirectory under `baseDirectory` that holds in-flight
 * temporary files. Hidden by the leading dot. The `.t` two-character
 * prefix cannot collide with any real sharded storage key, which shards
 * by hex or base58 (see {@link NodeFSStorageAdapter.getFilePath}), so
 * an older adapter walking a shard subtree never descends here.
 */
const TMP_DIR_NAME = ".tmp"

/**
 * Write `bytes` to `targetPath` atomically:
 *   1. write to `tmpPath` on the same filesystem as `targetPath`
 *   2. fsync the temporary file
 *   3. rename over the target
 *
 * On POSIX, rename is atomic with respect to concurrent readers and a
 * crash. On Windows NTFS, `fs.promises.rename` uses
 * `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` which is atomic for
 * concurrent readers; post-crash state on Windows depends on NTFS and
 * the OS flush policy.
 *
 * `tmpPath` MUST be on the same filesystem as `targetPath`; otherwise
 * `rename` will fail with `EXDEV` and no fallback is attempted. In
 * practice callers construct `tmpPath` under `<baseDirectory>/.tmp/`,
 * so this holds automatically.
 */
const atomicWrite = async (
  targetPath: string,
  tmpPath: string,
  bytes: Uint8Array
): Promise<void> => {
  const fh = await fs.promises.open(tmpPath, "w")
  let wroteTmp = false
  let closeErr: unknown
  try {
    await fh.writeFile(bytes)
    await fh.sync()
    wroteTmp = true
  } finally {
    // fh.close() can itself throw (e.g. EIO). Wrap it in its own
    // try/catch so the tmp-file cleanup below still runs. We always
    // capture the close error; whether we surface it depends on
    // whether the outer write succeeded (see below).
    try {
      await fh.close()
    } catch (e) {
      closeErr = e
    }
    if (!wroteTmp) {
      if (closeErr !== undefined) {
        console.debug(
          `[automerge-repo-storage-nodefs] fh.close() failed for ${tmpPath}:`,
          closeErr
        )
      }
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

  // Write + sync both succeeded, but close threw. On some filesystems
  // (NFS, FUSE) close is the only place certain delayed write errors
  // surface. Don't proceed with rename — the bytes on disk may not be
  // durable. Clean up the tmp file and surface the close error.
  if (closeErr !== undefined) {
    try {
      await fs.promises.unlink(tmpPath)
    } catch (cleanupErr) {
      console.debug(
        `[automerge-repo-storage-nodefs] failed to clean up tmp file ${tmpPath}:`,
        cleanupErr
      )
    }
    throw closeErr
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
 * Write `bytes` to `tmpPath` durably, without touching any target
 * file. Used by {@link NodeFSStorageAdapter.saveBatch} to stage each
 * entry before the commit (rename) phase.
 *
 *   1. open + writeFile + fsync + close
 *   2. if open/write/sync threw, best-effort unlink the tmp file and
 *      re-throw
 *   3. if close threw after a successful write+fsync, surface that
 *      error (on some filesystems close is where delayed write errors
 *      appear; see atomicWrite for the same pattern)
 */
const stageToTmp = async (
  tmpPath: string,
  bytes: Uint8Array
): Promise<void> => {
  const fh = await fs.promises.open(tmpPath, "w")
  let wroteTmp = false
  let closeErr: unknown
  try {
    await fh.writeFile(bytes)
    await fh.sync()
    wroteTmp = true
  } finally {
    try {
      await fh.close()
    } catch (e) {
      closeErr = e
    }
    if (!wroteTmp) {
      if (closeErr !== undefined) {
        console.debug(
          `[automerge-repo-storage-nodefs] fh.close() failed for ${tmpPath}:`,
          closeErr
        )
      }
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

  if (wroteTmp && closeErr !== undefined) {
    // Write + sync succeeded but close threw. Don't trust the tmp
    // file's durability; clean it up and surface the error.
    //
    // Note: guarded by `wroteTmp` so we don't double-unlink when the
    // !wroteTmp branch above already cleaned up and logged.
    try {
      await fs.promises.unlink(tmpPath)
    } catch (cleanupErr) {
      console.debug(
        `[automerge-repo-storage-nodefs] failed to clean up tmp file ${tmpPath}:`,
        cleanupErr
      )
    }
    throw closeErr
  }
}

/**
 * `fsync` a directory so that recent `rename(2)` calls into it are durable.
 */
const fsyncDir = async (dir: string): Promise<void> => {
  if (!IS_POSIX) return
  let fh: fs.promises.FileHandle | undefined
  try {
    fh = await fs.promises.open(dir, "r")
    await fh.sync()
  } catch (err: any) {
    if (err.code !== "EISDIR" && err.code !== "EINVAL") throw err
  } finally {
    // Swallow close() failures so they can't turn a tolerated fsync
    // outcome into a hard failure. Symmetric with the close handling
    // in atomicWrite.
    if (fh) {
      try {
        await fh.close()
      } catch (closeErr) {
        console.debug(
          `[automerge-repo-storage-nodefs] fsyncDir close() failed for ${dir}:`,
          closeErr
        )
      }
    }
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
        // Defensive: never descend into the tmp directory if walkdir is
        // ever invoked with `dirPath === baseDirectory`. Today loadRange
        // is always called with a prefix, so walkdir starts at a shard
        // subdirectory and this branch is effectively unreachable.
        if (entry.isDirectory() && entry.name === TMP_DIR_NAME) return []
        const subpath = path.resolve(dirPath, entry.name)
        return entry.isDirectory() ? walkdir(subpath) : subpath
      })
    )
    return files.flat()
  } catch (error: any) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return []
    throw error
  }
}
