/* eslint-disable automerge-slimport/enforce-automerge-slim-import */
import { Repo, PeerId } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { MessageChannel } from "worker_threads"
import { OperationGenerator } from "./operations.js"
import { NetworkConfig } from "./types.js"
import { next as Automerge } from "@automerge/automerge"

// Simple function to compare heads
function headsAreSame(heads1: string[], heads2: string[]): boolean {
  const set1 = new Set(heads1)
  const set2 = new Set(heads2)
  // Check if either set is a subset of the other
  return [...set1].every(h => set2.has(h)) || [...set2].every(h => set1.has(h))
}

type Doc = {
  text?: string
  list?: any[]
  map?: Record<string, any>
}

async function main() {
  // Create message channels for the star topology
  const { port1: portAC1, port2: portAC2 } = new MessageChannel() // A-C connection
  const { port1: portAD1, port2: portAD2 } = new MessageChannel() // A-D connection
  const { port1: portAE1, port2: portAE2 } = new MessageChannel() // A-E connection
  const { port1: portAB1, port2: portAB2 } = new MessageChannel() // A-B connection

  // Create the repos
  const peerA = "peerA" as PeerId
  const peerB = "peerB" as PeerId
  const peerC = "peerC" as PeerId
  const peerD = "peerD" as PeerId
  const peerE = "peerE" as PeerId

  const repoA = new Repo({
    network: [
      new MessageChannelNetworkAdapter(portAB1),
      new MessageChannelNetworkAdapter(portAC1),
      new MessageChannelNetworkAdapter(portAD1),
      new MessageChannelNetworkAdapter(portAE1),
    ],
    peerId: peerA,
    sharePolicy: async () => true,
  })

  const repoB = new Repo({
    network: [new MessageChannelNetworkAdapter(portAB2)],
    peerId: peerB,
    sharePolicy: async () => true,
  })

  const repoC = new Repo({
    network: [new MessageChannelNetworkAdapter(portAC2)],
    peerId: peerC,
    sharePolicy: async () => true,
  })

  const repoD = new Repo({
    network: [new MessageChannelNetworkAdapter(portAD2)],
    peerId: peerD,
    sharePolicy: async () => true,
  })

  const repoE = new Repo({
    network: [new MessageChannelNetworkAdapter(portAE2)],
    peerId: peerE,
    sharePolicy: async () => true,
  })

  // Create a document in repoA
  const handleA = repoA.create<Doc>()
  console.log("Created document in repoA:", handleA.documentId)

  // Share it with all other repos
  const handleB = await repoB.find<Doc>(handleA.documentId)
  console.log("Found document in repoB:", handleB.documentId)
  const handleC = await repoC.find<Doc>(handleA.documentId)
  console.log("Found document in repoC:", handleC.documentId)
  const handleD = await repoD.find<Doc>(handleA.documentId)
  console.log("Found document in repoD:", handleD.documentId)
  const handleE = await repoE.find<Doc>(handleA.documentId)
  console.log("Found document in repoE:", handleE.documentId)

  // Create operation generator
  const config: NetworkConfig = {
    peerId: peerA,
    peers: [peerB, peerC, peerD, peerE],
    numDocuments: 1,
    numOperations: 10000,
    operationTypes: [
      "TEXT_INSERT",
      "TEXT_DELETE",
      "LIST_INSERT",
      "LIST_DELETE",
      "MAP_SET",
    ],
    numPeers: 5,
    latency: 0,
    messageLoss: 0,
  }
  const generator = new OperationGenerator(config)

  // Generate and apply operations
  const operations = generator.generate(
    [peerA, peerB, peerC, peerD, peerE],
    [handleA.documentId]
  )

  console.log(`\nApplying ${operations.length} operations...`)
  let successCount = 0
  let skipCount = 0

  for (const op of operations) {
    // Apply the operation
    const handle =
      op.peerId === peerA
        ? handleA
        : op.peerId === peerB
        ? handleB
        : op.peerId === peerC
        ? handleC
        : op.peerId === peerD
        ? handleD
        : handleE
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

    // Every 1000 operations, print progress and verify docs match
    if (successCount % 1000 === 0) {
      console.log(
        `\nProgress: ${successCount} successful operations (${skipCount} skipped)`
      )
      console.log("DocA heads:", handleA.heads())
      console.log("DocB heads:", handleB.heads())
      console.log("DocC heads:", handleC.heads())
      console.log("DocD heads:", handleD.heads())
      console.log("DocE heads:", handleE.heads())

      // Wait for all heads to match, with timeout
      let waited = 0
      while (
        !headsAreSame(handleA.heads(), handleB.heads()) ||
        !headsAreSame(handleB.heads(), handleC.heads()) ||
        !headsAreSame(handleC.heads(), handleD.heads()) ||
        !headsAreSame(handleD.heads(), handleE.heads())
      ) {
        await new Promise(resolve => setTimeout(resolve, 10))
        waited += 10
        if (waited > 500) {
          console.error("Failed to synchronize after 500ms")
          console.log("DocA:", handleA.doc())
          console.log("DocB:", handleB.doc())
          console.log("DocC:", handleC.doc())
          console.log("DocD:", handleD.doc())
          console.log("DocE:", handleE.doc())
          process.exit(1)
        }
      }
      console.log("Heads synchronized after", waited, "ms")
    }
  }

  // Check final state in all repos
  console.log("\nFinal Results:")
  console.log(`Total operations: ${operations.length}`)
  console.log(`Successful operations: ${successCount}`)
  console.log(`Skipped operations: ${skipCount}`)
  console.log("Final DocA heads:", handleA.heads())
  console.log("Final DocB heads:", handleB.heads())
  console.log("Final DocC heads:", handleC.heads())
  console.log("Final DocD heads:", handleD.heads())
  console.log("Final DocE heads:", handleE.heads())

  // Wait for final heads to match, with timeout
  let waited = 0
  while (
    !headsAreSame(handleA.heads(), handleB.heads()) ||
    !headsAreSame(handleB.heads(), handleC.heads()) ||
    !headsAreSame(handleC.heads(), handleD.heads()) ||
    !headsAreSame(handleD.heads(), handleE.heads())
  ) {
    await new Promise(resolve => setTimeout(resolve, 10))
    waited += 10
    if (waited > 500) {
      console.error("Failed to synchronize final state after 500ms")
      console.log("Final DocA:", handleA.doc())
      console.log("Final DocB:", handleB.doc())
      console.log("Final DocC:", handleC.doc())
      console.log("Final DocD:", handleD.doc())
      console.log("Final DocE:", handleE.doc())
      process.exit(1)
    }
    // Debug logging
    if (waited % 100 === 0) {
      console.log("Waiting for final sync...")
      console.log(
        "A-B heads match:",
        headsAreSame(handleA.heads(), handleB.heads())
      )
      console.log(
        "B-C heads match:",
        headsAreSame(handleB.heads(), handleC.heads())
      )
      console.log(
        "C-D heads match:",
        headsAreSame(handleC.heads(), handleD.heads())
      )
      console.log(
        "D-E heads match:",
        headsAreSame(handleD.heads(), handleE.heads())
      )
      console.log("A heads:", handleA.heads())
      console.log("B heads:", handleB.heads())
      console.log("C heads:", handleC.heads())
      console.log("D heads:", handleD.heads())
      console.log("E heads:", handleE.heads())
    }
  }
  console.log("Final heads synchronized after", waited, "ms")

  await repoA.shutdown()
  await repoB.shutdown()
  await repoC.shutdown()
  await repoD.shutdown()
  await repoE.shutdown()
  console.log("Repos shut down successfully")
  process.exit(0)
}

main().catch(console.error)
