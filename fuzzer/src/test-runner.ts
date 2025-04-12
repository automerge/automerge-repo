import { Fuzzer } from "./index.js"
import { NetworkConfig, PeerId } from "./types.js"

const config: NetworkConfig = {
  peerId: "peer1" as PeerId,
  peers: ["peer2"].map(p => p as PeerId),
  numDocuments: 1,
  numPeers: 2,
  latency: 0,
  messageLoss: 0,
  numOperations: 100,
  operationTypes: ["TEXT_INSERT"],
}

const fuzzer = new Fuzzer(config)
fuzzer.run().catch(console.error)
