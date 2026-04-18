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
  private tmpDirectory: string
  private tmpDirectoryReady: Promise<void> | undefined
  private cache: { [key: string]: Uint8Array } = {}

  /**
   * @param baseDirectory - The path to the directory to store data in. Defaults to "./automerge-repo-data".
   */
  constructor(baseDirectory = "automerge-repo-data") {
    this.baseDirectory = baseDirectory
    // Same-filesystem tmp directory so rename(2) stays atomic. Hidden by
    // a leading dot so `ls` / casual listings don't show it. Real storage
    // keys shard by hex/base58 first two characters, so they never
    // collide with the literal `.t` shard — older adapters walking a
    // shard subtree will never descend into here.
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
      // Treat both "file not found" and "path component is not a
      // directory" as absent. ENOTDIR can surface when a key's
      // logical path passes through a location where some other
      // entry occupies the expected directory slot — from load()'s
      // perspective that still means "no file at this key".
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return undefined
      }
      throw error
    }
  }

  async save(keyArray: StorageKey, binary: Uint8Array): Promise<void> {
    // Populate the cache synchronously — before any await — so that an
    // in-process load() issued after this call but before the returned
    // promise resolves still observes the latest bytes. This preserves
    // the prior adapter's fire-and-forget contract; see
    // packages/automerge-repo/test/StorageSubsystem.test.ts
    // ("stores incremental changes following a load"), which performs
    // an unawaited saveDoc() followed by a fresh-subsystem load().
    //
    // If the on-disk write or fsync rejects, we roll the cache back to
    // its prior value so the cache never exposes bytes that aren't
    // durable. Fire-and-forget callers still see the latest bytes until
    // the promise rejects; awaited callers see a rejection and a cache
    // consistent with disk.
    const key = getKey(keyArray)
    const prev = this.cache[key]
    this.cache[key] = binary

    const filePath = this.getFilePath(keyArray)
    const dir = path.dirname(filePath)

    try {
      await this.ensureTmpDirectory()
      await fs.promises.mkdir(dir, { recursive: true })
      await atomicWrite(filePath, this.makeTmpPath(), binary)
      await fsyncDir(dir)
    } catch (err) {
      rollbackCache(this.cache, key, prev)
      throw err
    }
  }

  async saveBatch(entries: Array<[StorageKey, Uint8Array]>): Promise<void> {
    if (entries.length === 0) return

    // Capture prior cache state per key, then populate synchronously so
    // in-flight in-process loads still observe the batch. On failure we
    // use the per-entry settled results to roll back only the keys whose
    // on-disk writes did not succeed. See save() for rationale.
    const prevByKey: Array<[string, Uint8Array | undefined]> = []
    for (const [keyArray, binary] of entries) {
      const key = getKey(keyArray)
      prevByKey.push([key, this.cache[key]])
      this.cache[key] = binary
    }

    // Ensure the tmp directory exists once for the whole batch.
    try {
      await this.ensureTmpDirectory()
    } catch (err) {
      // tmp dir mkdir failed before any write; roll every entry back.
      for (const [key, prev] of prevByKey) {
        rollbackCache(this.cache, key, prev)
      }
      throw err
    }

    // Per-entry mkdir + atomicWrite in parallel, collecting individual
    // results so a partial failure can roll back only the affected
    // entries. mkdir is `recursive: true`, which is idempotent and
    // cheap on already-existing directories.
    const writeResults = await Promise.all(
      entries.map(([keyArray, binary]) => {
        const filePath = this.getFilePath(keyArray)
        const dir = path.dirname(filePath)
        return fs.promises
          .mkdir(dir, { recursive: true })
          .then(() => atomicWrite(filePath, this.makeTmpPath(), binary))
          .then(
            () => ({ ok: true as const }),
            err => ({ ok: false as const, err })
          )
      })
    )

    const failedIndices: number[] = []
    let firstErr: unknown
    for (let i = 0; i < writeResults.length; i++) {
      const r = writeResults[i]
      if (!r.ok) {
        failedIndices.push(i)
        if (firstErr === undefined) firstErr = r.err
      }
    }

    if (failedIndices.length > 0) {
      // Roll back only the failed entries' cache state; successful
      // entries are durable on disk and should remain in cache.
      for (const i of failedIndices) {
        const [key, prev] = prevByKey[i]
        rollbackCache(this.cache, key, prev)
      }
      throw firstErr
    }

    // fsync each distinct parent directory once so the renames are
    // durable. No-op on Windows. If this rejects, bytes are on disk
    // and cache matches disk — we don't roll back, but we do surface
    // the error so callers that care about durability see it.
    const dirs = new Set<string>()
    for (const [keyArray] of entries) {
      dirs.add(path.dirname(this.getFilePath(keyArray)))
    }
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

/**
 * Restore a cache entry to its value prior to a failed write.
 *
 * If the key had no prior entry (`prev === undefined`), the entry is
 * deleted entirely. Otherwise it is overwritten with the prior bytes.
 * This keeps the in-memory cache consistent with on-disk state when
 * save() / saveBatch() rejects partway through.
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
 * Matches the legacy tmp-file suffix format produced by earlier
 * versions of this adapter, when tmp files were siblings of their
 * target: `<target>.tmp.<pid>.<uuid-without-dashes>`. Current code
 * places tmp files in the {@link TMP_DIR_NAME} directory instead, so
 * this predicate exists only to filter stale siblings left behind by
 * crashes under the older layout during an upgrade window.
 */
const TMP_PATH_PATTERN = /\.tmp\.\d+\.[0-9a-f]{32}$/i

const isTmpPath = (p: string): boolean =>
  TMP_PATH_PATTERN.test(path.basename(p))

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
    // don't throw if directory not found
    if (error.code === "ENOENT") return []
    throw error
  }
}
