/**
 * This module provides a storage adapter for Redis.
 *
 * @packageDocumentation
 */

import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo"

import { Redis, RedisOptions } from "ioredis"
import debug from "debug"

const log = debug("automerge-repo:storage-redis")

export class RedisStorageAdapter implements StorageAdapterInterface {
  private redis: Redis

  /**
   * Create a new {@link RedisStorageAdapter}.
   * @param opts - Options to pass to the Redis client.
   */
  constructor(
    opts?: RedisOptions
  ) {
    this.redis = new Redis(opts)
    // TODO: handle errors
    this.redis.on("error", (err) => {
      log("redis error %O", err)
    })
  }

  async load(keyArray: StorageKey): Promise<Uint8Array | undefined> {
    const data = await this.redis.getBuffer(keyArray.join(":"))
    return data
  }

  async save(keyArray: string[], binary: Uint8Array): Promise<void> {
    console.log('save', binary.length, keyArray.join(":"))
    await this.redis.set(keyArray.join(":"), Buffer.from(binary))
  }

  async remove(keyArray: string[]): Promise<void> {
    await this.redis.del(keyArray.join(":"))
  }

  async loadRange(keyPrefix: string[]): Promise<Chunk[]> {
    const lowerBound = [...keyPrefix, '*'].join(":")
    const result: Chunk[] = []
    const stream = this.redis.scanStream({
      match: lowerBound,
    })
    stream.on("data", async (keys: string[]) => {
      for (const key of keys) {
        stream.pause()
        const data = await this.redis.getBuffer(key)
        result.push({
          key: key.split(":"),
          data,
        })
        stream.resume()
      }
    })
    return await new Promise((resolve, reject) => {
      stream.on("end", () => resolve(result))
      stream.on("error", (err) => reject(err))
    })
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    const lowerBound = [...keyPrefix, '*'].join(":")
    const stream = this.redis.scanStream({
      match: lowerBound,
    })
    stream.on("data", async (keys: string[]) => {
      for (const key of keys) {
        stream.pause()
        await this.redis.del(key)
        stream.resume()
      }
    })
    return await new Promise((resolve, reject) => {
      stream.on("end", resolve)
      stream.on("error", reject)
    })
  }
}
