import { Fuzzer } from "./index.js"
import { NetworkConfig } from "./types.js"
import { PeerId } from "@automerge/automerge-repo"
import { next as Automerge } from "@automerge/automerge"

// Create a test configuration
const config: NetworkConfig = {
  peerId: "peer1" as PeerId,
  peers: ["peer2"].map(p => p as PeerId),
  numDocuments: 2,
  numPeers: 2,
  latency: 100, // 100ms latency
  messageLoss: 0.1, // 10% message loss
  numOperations: 1,
  operationTypes: ["TEXT_INSERT"],
}

// Create and run the fuzzer
const fuzzer = new Fuzzer(config)

// Run the fuzzer with more operations
void fuzzer.run().then(result => {
  if (result.success) {
    console.log("Fuzzing passed!")
    console.log(`Test case: ${result.testCase.name}`)
    console.log(`Operations: ${result.testCase.operations.length}`)
  } else {
    console.error("Fuzzing failed:", result.error)
    console.error("Test case:", result.testCase)
  }
})
