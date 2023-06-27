import { PeerId, Repo } from "@automerge/automerge-repo"
import { eventPromise } from "@automerge/automerge-repo/src/helpers/eventPromise"
import { assert } from "chai"
import { BroadcastChannelNetworkAdapter } from "../src"

describe("BroadcastChannel", () => {
  it("can sync a document from one repo to another", async () => {
    const aliceRepo = new Repo({
      network: [new BroadcastChannelNetworkAdapter()],
      peerId: "alice" as PeerId,
    })

    const charlieRepo = new Repo({
      network: [new BroadcastChannelNetworkAdapter()],
      peerId: "charlie" as PeerId,
    })

    const p = eventPromise(charlieRepo, "document")

    const handle = aliceRepo.create<{ foo: string }>()
    handle.change(d => {
      d.foo = "bar"
    })

    await p

    const charlieHandle = charlieRepo.find<{ foo: string }>(handle.documentId)
    await eventPromise(charlieHandle, "change")
    const v = await charlieHandle.value()

    assert.equal(v.foo, "bar")
  })
})
