/* eslint-disable automerge-slimport/enforce-automerge-slim-import */
import { Repo, DocumentId, DocHandle } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { MessageChannel } from "worker_threads"
import { generateRandomOperation, applyOperation } from "./operations.js"
import { InMemoryStorage } from "./InMemoryStorage.js"
import { Automerge } from "@automerge/automerge-repo/slim"

// Define the document type
type Doc = {
  text?: string
  list?: any[]
  map?: Record<string, any>
}

// Helper function to create a repo with a message channel network adapter
function createRepo(storage: InMemoryStorage): Repo {
  const repo = new Repo({
    network: [new MessageChannelNetworkAdapter(new MessageChannel().port1)],
    storage,
  })
  return repo
}

// Helper function to check if two sets of heads are synchronized
function headsAreSame(heads1: string[], heads2: string[]): boolean {
  const set1 = new Set(heads1)
  const set2 = new Set(heads2)
  return [...set1].every(x => set2.has(x)) && [...set2].every(x => set1.has(x))
}

// Helper function to wait for synchronization
async function waitForSync(
  repos: Repo[],
  docId: DocumentId,
  timeout = 10000
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const allSynced = await Promise.all(
      repos.map(async repo => {
        const doc = await repo.find<Doc>(docId)
        if (!doc) return false
        const firstDoc = await repos[0].find<Doc>(docId)
        if (!firstDoc) return false
        return headsAreSame(doc.heads(), firstDoc.heads())
      })
    )
    if (allSynced.every(x => x)) return true
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}

async function main() {
  // Create storage instances for each peer
  const storages = Array.from({ length: 5 }, () => new InMemoryStorage())

  // Create repositories
  const repos = storages.map(storage => createRepo(storage))
  const [hub, ...spokes] = repos

  spokes.forEach(spoke => {
    const channel = new MessageChannel()
    hub.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(channel.port1)
    ) // hub to spoke
    spoke.networkSubsystem.addNetworkAdapter(
      new MessageChannelNetworkAdapter(channel.port2)
    ) // spoke to hub
  })

  // Create document in first repo
  const docHandle = hub.create<Doc>()
  await docHandle.change(doc => {
    doc.list = []
    doc.text = ""
  })
  console.log(Automerge.stats(docHandle.doc()))

  // Wait for document to be found in all repos
  const handles = await Promise.all(
    repos.map(repo => repo.find<Doc>(docHandle.documentId))
  )
  await Promise.all(handles)

  // Generate and apply operations
  const numOperations = 10000
  let successfulOperations = 0
  let skippedOperations = 0
  let lastLogTime = Date.now()
  let lastSync = 0

  for (let i = 0; i < numOperations; i++) {
    const targetRepo = repos[Math.floor(Math.random() * repos.length)]
    const targetHandle = await targetRepo.find<Doc>(docHandle.documentId)
    const opsPerChangeCount = 1 // todo: make random

    if (targetHandle) {
      try {
        targetHandle.change(doc => {
          for (let i = 0; i <= opsPerChangeCount; i++) {
            const op = generateRandomOperation()
            applyOperation(doc, op)
            successfulOperations++
          }
        })
      } catch (e) {
        console.log(`Operation failed: ${e}`)
        skippedOperations++
      }
    } else {
      skippedOperations++
    }
    // Log timing every second
    const endTime = Date.now()
    if (endTime - lastLogTime >= 1000) {
      const opsSinceLastLog = successfulOperations - lastSync
      const timeSinceLastLog = endTime - lastLogTime
      const avgTimePerOp = timeSinceLastLog / opsSinceLastLog
      console.log(
        `Operations ${
          successfulOperations - opsSinceLastLog
        }-${successfulOperations}:`
      )
      console.log(`  Total time: ${timeSinceLastLog}ms`)
      console.log(`  Average time per op: ${avgTimePerOp.toFixed(2)}ms`)
      lastSync = successfulOperations
      lastLogTime = endTime
    }

    // Check synchronization every 1000 operations
    if (successfulOperations % 100 === 0) {
      console.log("Waiting for sync...")
      const synced = await waitForSync(repos, docHandle.documentId)
      if (!synced) {
        console.log("Synchronization failed; giving up")
        break
      }
    }
  }

  // Final synchronization check
  const finalSynced = await waitForSync(repos, docHandle.documentId, 10000)
  if (!finalSynced) {
    console.log("Final synchronization failed")
  }

  console.log(`\nTotal operations: ${numOperations}`)
  console.log(`Successful operations: ${successfulOperations}`)
  console.log(`Skipped operations: ${skippedOperations}`)
}

main().catch(console.error)
