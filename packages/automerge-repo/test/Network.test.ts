import assert from "assert"
import { NetworkSubsystem } from "../src/network/NetworkSubsystem.js"
import { PeerId } from "../src"

// TODO
describe("Network", () => {
  it("TODO", () => {
    const alice = "alice" as PeerId
    const network = new NetworkSubsystem([], alice)
    assert(network !== null)
  })
})
