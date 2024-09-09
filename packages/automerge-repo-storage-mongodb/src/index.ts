/**
 * @packageDocumentation
 * A `StorageAdapter` which stores data in MongoDB
 */

import {
  Chunk,
  StorageAdapterInterface,
  type StorageKey,
} from "@automerge/automerge-repo/slim"
import { MongoClient, MongoClientOptions, Collection, BSON } from "mongodb"
import assert from "node:assert"

// function storageKeyToString(key: StorageKey) {
//   return key.join("/")
// }

/**
 * Assert that the argument passed is an array of strings
 * NOTE: This is necessary to enable passing this directly to the database
 */
function assertStorageKey(value: unknown): asserts value is StorageKey {
  assert(Array.isArray(value), "Expected an array")
  for (const element of value) {
    assert(typeof element === "string", "Expected an array of strings")
  }
}

/**
 * Builds a query filter from a key prefix using "array index position"
 * See https://www.mongodb.com/docs/manual/tutorial/query-arrays/#query-for-an-element-by-the-array-index-position
 */
function buildKeyPrefixFilter(keyPrefix: StorageKey) {
  return Object.fromEntries(keyPrefix.map((part, i) => {
    return [`key.${i}`, part]
  }))
}

type ChunkDocument = { key: StorageKey; data: BSON.Binary }

type MongoDBStorageAdapterOptions = {
  dbName?: string
  collectionName?: string
  /** The strategy for storing and querying keys */
  keyStorageStrategy?: "array" | "string"
}

export class MongoDBStorageAdapter implements StorageAdapterInterface {
  #client: MongoClient
  #dbName: string
  #collectionName: string
  #collection: Promise<Collection<ChunkDocument>> | undefined = undefined

  /**
   * @param url - The url of the MongoDB server.
   * @param options - Additional options to pass when instantiating the MongoDB client.
   */
  constructor(
    url: string,
    options?: MongoDBStorageAdapterOptions & MongoClientOptions
  )

  /**
   * @param client - The MongoDB client.
   * @param options - Additional options.
   */
  constructor(client: MongoClient, options?: MongoDBStorageAdapterOptions)

  /**
   * @param url - The url of the MongoDB server.
   * @param options - Additional options to pass when instantiating the MongoDB client.
   */
  constructor(
    urlOrClient: MongoClient | string,
    {
      dbName = "automerge",
      collectionName = "chunks",
      keyStorageStrategy = "array",
      ...clientOptions
    }: MongoDBStorageAdapterOptions & MongoClientOptions = {}
  ) {
    this.#dbName = dbName
    this.#collectionName = collectionName
    if (typeof urlOrClient === "string") {
      this.#client = new MongoClient(urlOrClient, clientOptions)
    } else if (urlOrClient instanceof MongoClient) {
      this.#client = urlOrClient
    } else {
      throw new TypeError(
        "Expected first argument to be either a client or a url string"
      )
    }
    if (keyStorageStrategy === "string") {
      throw new Error("Using strings for key storage isn't implemented yet")
    }
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    assertStorageKey(key)
    const collection = await this.collection
    const result = await collection.findOne({ key })
    if (result) {
      return new Uint8Array(result.data.value())
    } else {
      return undefined
    }
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    assertStorageKey(key)
    const collection = await this.collection
    await collection.updateOne(
      { key: key },
      { $set: { data: new BSON.Binary(data) } },
      { upsert: true }
    )
  }

  async remove(key: StorageKey): Promise<void> {
    assertStorageKey(key)
    const collection = await this.collection
    await collection.deleteOne({ key })
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    assertStorageKey(keyPrefix)
    const collection = await this.collection
    const query = buildKeyPrefixFilter(keyPrefix)
    const cursor = await collection.find(query)
    if (cursor) {
      const result: Chunk[] = []
      for await (const { key, data } of cursor) {
        result.push({ key, data: new Uint8Array(data.value()) })
      }
      return result
    } else {
      return []
    }
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    assertStorageKey(keyPrefix)
    const collection = await this.collection
    const query = buildKeyPrefixFilter(keyPrefix)
    await collection.deleteMany(query)
  }

  private get collection(): Promise<Collection<ChunkDocument>> {
    // Lazily connects the client and constructs the db and collection
    if (!this.#collection) {
      this.#collection = this.#client
        .connect()
        .then(client =>
          client.db(this.#dbName).collection(this.#collectionName)
        )
    }
    return this.#collection
  }
}
