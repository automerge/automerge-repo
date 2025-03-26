import { beelay } from "@automerge/automerge"
import { StorageAdapter } from "./StorageAdapter.js"

export class BeelayStorageAdapter implements beelay.StorageAdapter {
  #wrapped: StorageAdapter

  constructor(wrapped: StorageAdapter) {
    this.#wrapped = wrapped
  }

  load(key: string[]): Promise<Uint8Array | undefined> {
    return this.#wrapped.load(beelayKey(key))
  }
  async loadRange(prefix: string[]): Promise<Map<string[], Uint8Array>> {
    let chunks = await this.#wrapped.loadRange(beelayKey(prefix))
    let result = new Map()
    for (const chunk of chunks) {
      result.set(stripBeelayPrefix(chunk.key), chunk.data)
    }
    return result
  }
  save(key: string[], data: Uint8Array): Promise<void> {
    return this.#wrapped.save(beelayKey(key), data)
  }
  remove(key: string[]): Promise<void> {
    return this.#wrapped.remove(beelayKey(key))
  }
  async listOneLevel(prefix: string[]): Promise<Array<string[]>> {
    let beelayPrefix = beelayKey(prefix)
    const allkeys = await this.#wrapped.loadRange(beelayPrefix)
    const resultJoined = new Set<string>()
    for (const chunk of allkeys) {
      let oneDeeper = oneLevelDeeper(chunk.key, beelayPrefix)
      if (oneDeeper != null) {
        resultJoined.add(stripBeelayPrefix(oneDeeper).join("/"))
      }
    }
    const result = []
    for (const joined of resultJoined) {
      result.push(joined.split("/"))
    }
    return result
  }

  async loadSigningKey(): Promise<Uint8Array | undefined> {
    let key = beelayKey(["signingKey"])
    return await this.#wrapped.load(key)
  }

  async saveSigningKey(keyBytes: Uint8Array): Promise<void> {
    let key = beelayKey(["signingKey"])
    await this.#wrapped.save(key, keyBytes)
  }
}

function beelayKey(key: string[]): string[] {
  return ["beelay", ...key]
}

function oneLevelDeeper(key: string[], prefix: string[]): string[] | null {
  if (isPrefix(prefix, key) && key.length > prefix.length) {
    return key.slice(0, prefix.length + 1)
  }
  return null
}

function isPrefix(prefix: string[], key: string[]): boolean {
  return (
    key.length >= prefix.length &&
    key.slice(0, prefix.length).every((k, i) => k === prefix[i])
  )
}

function stripBeelayPrefix(key: string[]): string[] {
  return key.slice(1)
}
