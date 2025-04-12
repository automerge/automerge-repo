/* eslint-disable automerge-slimport/enforce-automerge-slim-import */
import { Repo, PeerId } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { MessageChannel } from "worker_threads"
import { OperationGenerator } from "./operations.js"
import { NetworkConfig } from "./types.js"
import { next as Automerge } from "@automerge/automerge"

// Simple function to compare heads
function headsAreSame(heads1: string[], heads2: string[]): boolean {
  if (heads1.length !== heads2.length) return false
  const set1 = new Set(heads1)
  return heads2.every(h => set1.has(h))
}

type Doc = {
  text?: string
  list?: any[]
  map?: Record<string, any>
}

async function main() {
  // Create a message channel between the two repos
  const { port1, port2 } = new MessageChannel()

  // Create the first repo
  const peer1 = "peer1" as PeerId
  const repo1 = new Repo({
    network: [new MessageChannelNetworkAdapter(port1)],
    peerId: peer1,
    sharePolicy: async () => true,
  })

  // Create the second repo
  const peer2 = "peer2" as PeerId
  const repo2 = new Repo({
    network: [new MessageChannelNetworkAdapter(port2)],
    peerId: peer2,
    sharePolicy: async () => true,
  })

  // Create a document in repo1
  const handle1 = repo1.create<Doc>()
  console.log("Created document in repo1:", handle1.documentId)

  // Share it with repo2
  const handle2 = await repo2.find<Doc>(handle1.documentId)
  console.log("Found document in repo2:", handle2.documentId)

  // Create operation generator
  const config: NetworkConfig = {
    peerId: peer1,
    peers: [peer2],
    numDocuments: 1,
    numOperations: 1000,
    operationTypes: [
      "TEXT_INSERT",
      "TEXT_DELETE",
      "LIST_INSERT",
      "LIST_DELETE",
      "MAP_SET",
    ],
    numPeers: 2,
    latency: 0,
    messageLoss: 0,
  }
  const generator = new OperationGenerator(config)

  // Generate and apply operations
  const operations = generator.generate([peer1, peer2], [handle1.documentId])

  console.log(`\nApplying ${operations.length} operations...`)
  let successCount = 0
  let skipCount = 0

  for (const op of operations) {
    // Apply the operation
    const handle = op.peerId === peer1 ? handle1 : handle2
    handle.change(doc => {
      const index = Number(op.path![op.path!.length - 1])
      const pathPrefix = op.path!.slice(0, -1)

      switch (op.type) {
        case "TEXT_INSERT":
          if (!doc.text) doc.text = ""
          if (index <= doc.text.length) {
            Automerge.splice(doc, pathPrefix, index, 0, op.value)
            successCount++
          } else {
            skipCount++
          }
          break
        case "TEXT_DELETE":
          if (!doc.text) doc.text = ""
          if (index < doc.text.length) {
            Automerge.splice(doc, pathPrefix, index, 1)
            successCount++
          } else {
            skipCount++
          }
          break
        case "LIST_INSERT":
          if (!doc.list) doc.list = []
          if (index <= doc.list.length) {
            doc.list.splice(index, 0, op.value)
            successCount++
          } else {
            skipCount++
          }
          break
        case "LIST_DELETE":
          if (!doc.list) doc.list = []
          if (index < doc.list.length) {
            doc.list.splice(index, 1)
            successCount++
          } else {
            skipCount++
          }
          break
        case "MAP_SET":
          if (!doc.map) doc.map = {}
          doc.map[op.path![op.path!.length - 1]] = op.value
          successCount++
          break
      }
    })

    // Wait a tiny bit for sync
    await new Promise(resolve => setTimeout(resolve, 1))

    // Every 100 operations, print progress and verify docs match
    if (successCount % 100 === 0) {
      console.log(
        `\nProgress: ${successCount} successful operations (${skipCount} skipped)`
      )
      console.log("Doc1 heads:", handle1.heads())
      console.log("Doc2 heads:", handle2.heads())

      // Wait for heads to match, with timeout
      let waited = 0
      while (!headsAreSame(handle1.heads(), handle2.heads())) {
        await new Promise(resolve => setTimeout(resolve, 10))
        waited += 10
        if (waited > 100) {
          console.error("Failed to synchronize after 100ms")
          console.log("Doc1:", handle1.doc())
          console.log("Doc2:", handle2.doc())
          process.exit(1)
        }
      }
      console.log("Heads synchronized after", waited, "ms")
    }
  }

  // Check final state in both repos
  console.log("\nFinal Results:")
  console.log(`Total operations: ${operations.length}`)
  console.log(`Successful operations: ${successCount}`)
  console.log(`Skipped operations: ${skipCount}`)
  console.log("Final Doc1 heads:", handle1.heads())
  console.log("Final Doc2 heads:", handle2.heads())

  await repo1.shutdown()
  await repo2.shutdown()
  console.log("Repos shut down successfully")
  process.exit(0) // Force exit after shutdown
}

main().catch(console.error)
