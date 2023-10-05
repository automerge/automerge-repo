import assert from "assert"
import { describe, it } from "vitest"
import { NetworkSubsystem } from "../src/network/NetworkSubsystem.js"

// Note: The sync tests in `Repo.test.ts` exercise the network subsystem, and the suite in
// `automerge-repo` provides test utilities that individual adapters can
// use to ensure that they work correctly.

describe("Network subsystem", () => {
  it("Can be instantiated", () => {
    const network = new NetworkSubsystem([])
    assert(network !== null)
  })
})
