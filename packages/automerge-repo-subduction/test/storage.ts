import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import type { LocalByteStore } from "../src/index.js"

/** Test-only filesystem store: rename gives atomic replacement, not fsync. */
export class DiskStore implements LocalByteStore {
  beforeSave?: (key: string) => Promise<void>
  constructor(readonly root: string) {}
  async load(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(join(this.root, key)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
  }
  async save(key: string, value: Uint8Array): Promise<void> {
    const copy = new Uint8Array(value)
    await this.beforeSave?.(key)
    const path = join(this.root, key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(`${path}.tmp`, copy)
    await rename(`${path}.tmp`, path)
  }
  async remove(key: string): Promise<void> {
    await rm(join(this.root, key), { force: true })
  }
  async list(prefix: string): Promise<string[]> {
    const result: string[] = []
    const walk = async (path: string): Promise<void> => {
      let entries
      try {
        entries = await readdir(join(this.root, path), { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      }
      for (const entry of entries) {
        const key = path ? `${path}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(key)
        else if (key.startsWith(prefix) && !key.endsWith(".tmp"))
          result.push(key)
      }
    }
    await walk("")
    return result.sort()
  }
  async loadPrefix(prefix: string): Promise<[string, Uint8Array][]> {
    const entries: [string, Uint8Array][] = []
    for (const key of await this.list(prefix)) {
      const value = await this.load(key)
      if (value !== undefined) entries.push([key, value])
    }
    return entries
  }
}
export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => {
    resolve = r
  })
  return { promise, resolve }
}
