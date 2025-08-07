import { Repo, type StorageKey, StorageAdapterInterface, Chunk, AutomergeUrl } from "@automerge/automerge-repo"
import assert from "assert"
import { describe, expect, it } from "vitest"
import { Bundle, exportBundle, importBundle } from "../src/index.js"
import * as A from "@automerge/automerge"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"

describe("when exporting and importing bundles", () => {
  it("should be able to export and import a bundle", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc = bob.create({ foo: "bar" })
    const bundle = exportBundle(bob, [bobDoc])
    const encoded = bundle.encode()
    const decoded = Bundle.decode(encoded)

    importBundle(alice, decoded)

    const aliceDoc = await alice.find(bobDoc.url)
    assert.deepStrictEqual(aliceDoc.doc(), { foo: "bar" })
  })

  it("should export and import multiple doc handles", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc1 = bob.create({ foo: "bar" })
    const bobDoc2 = bob.create({ baz: "qux" })
    const bundle = exportBundle(bob, [bobDoc1, bobDoc2])
    const encoded = bundle.encode()
    const decoded = Bundle.decode(encoded)

    importBundle(alice, decoded)

    const aliceDoc1 = await alice.find(bobDoc1.url)
    assert.deepStrictEqual(aliceDoc1.doc(), { foo: "bar" })

    const aliceDoc2 = await alice.find(bobDoc2.url)
    assert.deepStrictEqual(aliceDoc2.doc(), { baz: "qux" })
  })

  it("should return the documents that are ready as a result of loading the bundle", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc = bob.create({ foo: "bar" })
    const bundle = exportBundle(bob, [bobDoc]).encode()

    const imported = importBundle(alice, bundle)
    assert.deepStrictEqual(imported[bobDoc.url].doc(), { foo: "bar" })
  })

  it("allows you to create a bundle containing only new changes", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc = bob.create({ foo: "bar" })
    const amBobHeads = A.getHeads(bobDoc.doc())
    const bobHeads = bobDoc.heads()
    const firstBundle = exportBundle(bob, [bobDoc])

    bobDoc.change(d => (d.foo = "baz"))
    const incrementalBundle = exportBundle(bob, [bobDoc], {
      since: new Map([[bobDoc.url, bobHeads]]),
    }).encode()
    const decodedIncremental = Bundle.decode(incrementalBundle)

    const bundleData = decodedIncremental.data.get(bobDoc.url)!
    assert.deepStrictEqual(bundleData.deps, amBobHeads)
    assert.deepStrictEqual(bundleData.heads, A.getHeads(bobDoc.doc()))

    importBundle(alice, firstBundle)
    const imported = importBundle(alice, decodedIncremental)
    assert.deepStrictEqual(imported[bobDoc.url].doc(), { foo: "baz" })
  })

  it("marks a document as available if the bundle contained changes which can be used", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc = bob.create({ foo: "bar" })
    const bobHeads = bobDoc.heads()
    const firstBundle = exportBundle(bob, [bobDoc]).encode()

    bobDoc.change(d => (d.foo = "baz"))
    const incrementalBundle = exportBundle(bob, [bobDoc], {
      since: new Map([[bobDoc.url, bobHeads]]),
    })
    const encoded = incrementalBundle.encode()

    // Import the incremental first, which should not find the doc because
    // we are missing changes
    const importedIncremental = importBundle(alice, encoded)
    assert.equal(Object.entries(importedIncremental).length, 0)
    const imported = importBundle(alice, firstBundle)
    assert.deepStrictEqual(imported[bobDoc.url].doc(), { foo: "baz" })
  })

  it("marks an existing requesting document as available", async () => {
    const bob = new Repo()
    const alice = new Repo()

    const bobDoc = bob.create({ foo: "bar" })

    const bundle = exportBundle(bob, [bobDoc])
    const encoded = bundle.encode()

    const findWithProgress = alice.findWithProgress(bobDoc.url)
    assert.equal(findWithProgress.state, "loading")

    importBundle(alice, encoded)
    await findWithProgress.handle.whenReady(["ready"])
    assert.deepStrictEqual(findWithProgress.handle.doc(), { foo: "bar" })
  })

  it("repo persists the bundle data to storage", async () => {
    const storage = new DummyStorageAdapter()

    let url: AutomergeUrl;
    {
      const alice = new Repo({ storage })
      const bob = new Repo()

      const bobDoc = bob.create({ foo: "bar" })
      url = bobDoc.url
      const bundle = exportBundle(bob, [bobDoc])

      const encoded = bundle.encode()
      importBundle(alice, encoded);

      const handle = await alice.find(bobDoc.url)
      assert.deepStrictEqual(handle.doc(), { foo: "bar" })
      // Should not be required.
      // await alice.flush()
    }

    {
      const alice = new Repo({ storage })
      const handle = await alice.find(url)
      assert.deepStrictEqual(handle.doc(), { foo: "bar" })
    }
  })

  it.only('imported document is synced over the network', async () => {
    const { port1: ab, port2: ba } = new MessageChannel()
    const alice = new Repo({ network: [new MessageChannelNetworkAdapter(ab)] })
    const bob = new Repo({ network: [new MessageChannelNetworkAdapter(ba)] })
    const charlie = new Repo()

    const charlieDoc = charlie.create({ foo: "bar" })
    const bundle = exportBundle(charlie, [charlieDoc])
    importBundle(bob, bundle)

    const findWithProgress = alice.findWithProgress(charlieDoc.url)
    assert.equal(findWithProgress.state, "loading")
    await findWithProgress.handle.whenReady(["ready"])
    assert.deepStrictEqual(findWithProgress.handle.doc(), { foo: "bar" })
  })
})

export class DummyStorageAdapter implements StorageAdapterInterface {
  #data: Record<string, Uint8Array> = {}

  #keyToString(key: string[]): string {
    return key.join(".")
  }

  #stringToKey(key: string): string[] {
    return key.split(".")
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const range = Object.entries(this.#data)
      .filter(([key, _]) => key.startsWith(this.#keyToString(keyPrefix)))
      .map(([key, data]) => ({ key: this.#stringToKey(key), data }))
    return Promise.resolve(range)
  }

  async removeRange(keyPrefix: string[]): Promise<void> {
    Object.entries(this.#data)
      .filter(([key, _]) => key.startsWith(this.#keyToString(keyPrefix)))
      .forEach(([key, _]) => delete this.#data[key])
  }

  async load(key: string[]): Promise<Uint8Array | undefined> {
    return new Promise(resolve => resolve(this.#data[this.#keyToString(key)]))
  }

  async save(key: string[], binary: Uint8Array) {
    this.#data[this.#keyToString(key)] = binary
    return Promise.resolve()
  }

  async remove(key: string[]) {
    delete this.#data[this.#keyToString(key)]
  }

  keys() {
    return Object.keys(this.#data)
  }
}
