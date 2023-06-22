import { PeerId, Repo, type NetworkAdapter } from "automerge-repo"
import { eventPromise } from "automerge-repo/src/helpers/eventPromise"
import { assert } from "chai"
import { describe, it } from "mocha"

const alice = "alice" as PeerId
const bob = "bob" as PeerId
const charlie = "charlie" as PeerId

/**
 * Runs a series of tests against a set of three peers, each represented by one or more instantiated network adapters
 */
export function runAdapterTests(_setup: SetupFn, title?: string): void {
  const setup = async () => {
    const { adapters, teardown } = await _setup()

    // these might be individual adapters or arrays of adapters; normalize them to arrays
    const [a, b, c] = adapters.map(toArray)

    return { adapters: [a, b, c], teardown }
  }

  describe(`Adapter acceptance tests ${title ? `(${title})` : ""}`, () => {
    it("can sync documents between two repos", async () => {
      const doTest = async (
        aliceAdapters: NetworkAdapter[],
        bobAdapters: NetworkAdapter[]
      ) => {
        const aliceRepo = new Repo({ network: aliceAdapters, peerId: alice })
        const bobRepo = new Repo({ network: bobAdapters, peerId: bob })

        // Alice creates a document
        const aliceHandle = aliceRepo.create<TestDoc>()

        // Bob receives the document
        await eventPromise(bobRepo, "document")
        const BobHandle = bobRepo.find<TestDoc>(aliceHandle.documentId)

        // Alice changes the document
        aliceHandle.change(d => {
          d.foo = "bar"
        })

        // Bob receives the change
        await eventPromise(BobHandle, "change")
        const v1 = await BobHandle.value()
        assert.equal(v1.foo, "bar")

        // Bob changes the document
        BobHandle.change(d => {
          d.foo = "baz"
        })

        // Alice receives the change
        await eventPromise(aliceHandle, "change")
        const v2 = await aliceHandle.value()
        assert.equal(v2.foo, "baz")
      }

      // Run the test in both directions, in case they're different types of adapters
      {
        const { adapters, teardown = NO_OP } = await setup()
        const [x, y] = adapters
        await doTest(x, y) // x is Alice
        teardown()
      }
      {
        const { adapters, teardown = NO_OP } = await setup()
        const [x, y] = adapters
        await doTest(y, x) // y is Alice
        teardown()
      }
    })

    it("something else", async () => {
      assert.isTrue(true)
    })
  })
}

const NO_OP = () => {}

type NetworkAdapters = NetworkAdapter | NetworkAdapter[]
export type SetupFn = () => Promise<{
  adapters: [NetworkAdapters, NetworkAdapters, NetworkAdapters]
  teardown?: () => void
}>

type TestDoc = {
  foo: string
}

const toArray = <T>(x: T | T[]) => (Array.isArray(x) ? x : [x])
