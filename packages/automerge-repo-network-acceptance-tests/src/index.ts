import { PeerId, Repo, type NetworkAdapter } from "automerge-repo"
import { eventPromise } from "automerge-repo/src/helpers/eventPromise"
import { assert } from "chai"
import { describe, it } from "mocha"

const alice = "alice" as PeerId
const bob = "bob" as PeerId
const charlie = "charlie" as PeerId
/**
 * Runs a series of
 */
export function runAdapterTests(setup: SetupFn, title?: string): void {
  describe(`Adapter acceptance tests ${title ? `(${title})` : ""}`, () => {
    it("can sync a document from one repo to another", async () => {
      const {
        adapters: [aliceAdapter, bobAdapter],
        teardown = NO_OP,
      } = await setup()

      const aliceRepo = new Repo({ network: [aliceAdapter], peerId: alice })
      const bobRepo = new Repo({ network: [bobAdapter], peerId: bob })

      // Alice creates a document
      const aliceHandle = aliceRepo.create<{ foo: string }>()

      // Bob receives the document
      await eventPromise(bobRepo, "document")
      const bobHandle = bobRepo.find<{ foo: string }>(aliceHandle.documentId)

      // Alice changes the document
      aliceHandle.change(d => {
        d.foo = "bar"
      })

      // Bob receives the change
      await eventPromise(bobHandle, "change")
      const v = await bobHandle.value()
      assert.equal(v.foo, "bar")

      // Bob changes the document
      bobHandle.change(d => {
        d.foo = "baz"
      })

      // Alice receives the change
      await eventPromise(aliceHandle, "change")
      const v2 = await aliceHandle.value()
      assert.equal(v2.foo, "baz")

      teardown()
    })

    it("something else", async () => {
      assert.isTrue(true)
    })
  })
}

export type SetupFn = () => Promise<{
  adapters: [NetworkAdapter, NetworkAdapter]
  teardown?: () => void
}>

const NO_OP = () => {}
