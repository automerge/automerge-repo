import { Fuzzer } from "./index.js"
import { NetworkConfig, PeerId } from "./types.js"

describe("Fuzzer", () => {
  let fuzzer: Fuzzer
  const config: NetworkConfig = {
    peerId: "peer1" as PeerId,
    peers: ["peer2", "peer3"].map(p => p as PeerId),
    numDocuments: 1,
    numOperations: 10,
    operationTypes: [
      "TEXT_INSERT",
      "TEXT_DELETE",
      "MAP_SET",
      "LIST_INSERT",
      "LIST_DELETE",
    ],
    latency: 0,
    messageLoss: 0,
    numPeers: 3,
  }

  beforeEach(() => {
    fuzzer = new Fuzzer(config)
  })

  describe("run", () => {
    it("should successfully run a fuzzing test", async () => {
      const result = await fuzzer.run()
      expect(result.success).toBe(true)
    })

    it("should generate the correct number of operations", async () => {
      const result = await fuzzer.run()
      expect(result.testCase.operations).toHaveLength(config.numOperations)
    })

    it("should distribute operations across peers", async () => {
      const result = await fuzzer.run()
      const peerOperations = new Map<PeerId, number>()

      for (const op of result.testCase.operations) {
        const count = peerOperations.get(op.peerId) || 0
        peerOperations.set(op.peerId, count + 1)
      }

      // Each peer should have at least one operation
      expect(peerOperations.size).toBe(config.peers.length + 1) // +1 for peer1
      for (const count of peerOperations.values()) {
        expect(count).toBeGreaterThan(0)
      }
    })
  })

  describe("operation application", () => {
    it("should handle TEXT_INSERT operations correctly", async () => {
      const result = await fuzzer.run()
      const textInserts = result.testCase.operations.filter(
        op => op.type === "TEXT_INSERT"
      )

      for (const op of textInserts) {
        expect(op.path).toBeDefined()
        expect(op.value).toBeDefined()
        expect(op.path).toHaveLength(2)
        expect(op.path![0]).toBe("text")
      }
    })

    it("should handle MAP_SET operations correctly", async () => {
      const result = await fuzzer.run()
      const mapSets = result.testCase.operations.filter(
        op => op.type === "MAP_SET"
      )

      for (const op of mapSets) {
        expect(op.path).toBeDefined()
        expect(op.value).toBeDefined()
        expect(op.path).toHaveLength(1)
      }
    })

    it("should handle LIST operations correctly", async () => {
      const result = await fuzzer.run()
      const listOps = result.testCase.operations.filter(
        op => op.type === "LIST_INSERT" || op.type === "LIST_DELETE"
      )

      for (const op of listOps) {
        expect(op.path).toBeDefined()
        if (op.type === "LIST_INSERT") {
          expect(op.value).toBeDefined()
        }
        expect(op.path).toHaveLength(2)
      }
    })
  })
})
