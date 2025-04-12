// eslint-disable-next-line automerge-slimport/enforce-automerge-slim-import
import { Repo, PeerId, DocumentId, DocHandle } from "@automerge/automerge-repo"
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel"
import { MessageChannel } from "worker_threads"
// eslint-disable-next-line automerge-slimport/enforce-automerge-slim-import
import { next as Automerge } from "@automerge/automerge"
import { OperationGenerator } from "./operations.js"
import { StateVerifier } from "./verifier.js"
import { NetworkConfig, OperationType } from "./types.js"

export class Fuzzer {
  private repos: Map<PeerId, Repo>
  private handles: Map<DocumentId, DocHandle<any>>
  private operationGenerator: OperationGenerator
  private verifier: StateVerifier
  private config: NetworkConfig
  private testCase: {
    name: string
    config: NetworkConfig
    operations: Array<{
      type: OperationType
      peerId: PeerId
      documentId: DocumentId
      value?: any
      path?: string[]
    }>
  }

  constructor(config: NetworkConfig) {
    console.log("Fuzzer constructor", config)
    this.config = config
    this.handles = new Map()
    this.repos = new Map()
    this.operationGenerator = new OperationGenerator(config)
    this.verifier = new StateVerifier()
    this.testCase = {
      name: "test-case",
      config,
      operations: [],
    }

    // Create message channels for each peer pair
    const peers = [config.peerId, ...config.peers]
    const channels = new Map<string, MessageChannel>()

    // Create channels between each pair of peers
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const key = `${peers[i]}-${peers[j]}`
        channels.set(key, new MessageChannel())
      }
    }

    // Create repos with their network adapters
    for (const peerId of peers) {
      const adapters = []

      // Connect this peer to all other peers
      for (const otherPeer of peers) {
        if (peerId === otherPeer) continue

        // Get the channel between these peers
        const key = [peerId, otherPeer].sort().join("-")
        const channel = channels.get(key)!

        // Use port1 if this peer comes first alphabetically, port2 if second
        const port =
          [peerId, otherPeer].sort()[0] === peerId
            ? channel.port1
            : channel.port2

        const adapter = new MessageChannelNetworkAdapter(port)
        adapter.connect(peerId as PeerId)
        adapters.push(adapter)
      }

      const repo = new Repo({
        network: adapters,
        peerId: peerId as PeerId,
        sharePolicy: async () => true,
      })
      this.repos.set(peerId, repo)
    }
  }

  async run() {
    console.log("Starting fuzzer test...")
    console.log(
      `Peers: ${[this.config.peerId, ...this.config.peers].join(", ")}`
    )

    // Wait for all peers to connect
    console.log("Waiting for peers to connect...")
    const peerPromises = []
    for (const [peerId, repo] of this.repos.entries()) {
      peerPromises.push(
        new Promise<void>(resolve => {
          repo.networkSubsystem.once("peer", payload => {
            console.log(`Peer ${payload.peerId} connected to ${peerId}`)
            resolve()
          })
        })
      )
    }

    // Wait for all peer connections
    await Promise.all(peerPromises)
    console.log("All peers connected")

    // Initialize peers and documents
    const peers = this.config.peers.map((peerId: string) => peerId as PeerId)
    const documents = []

    // Create documents and wait for them to be ready
    console.log(`Creating ${this.config.numDocuments} documents...`)
    const mainRepo = this.repos.get(this.config.peerId)!
    for (let i = 0; i < this.config.numDocuments; i++) {
      const doc = mainRepo.create()
      documents.push(doc.documentId as DocumentId)
      console.log(`Created document ${doc.documentId}`)
    }

    // Share documents with all peers
    console.log("Sharing documents with peers...")
    for (const docId of documents) {
      for (const [peerId, repo] of this.repos.entries()) {
        const handle = await repo.find(docId)
        if (handle) {
          this.handles.set(docId, handle)
          console.log(`Document ${docId} shared with peer ${peerId}`)
        }
      }
    }

    // Generate and apply operations
    console.log("Generating operations...")
    const operations = this.operationGenerator.generate(peers, documents)
    console.log(`Generated ${operations.length} operations`)

    console.log("Applying operations...")
    for (const operation of operations) {
      this.testCase.operations.push(operation)
      await this.applyOperation(operation)
      console.log(
        `Applied operation: ${operation.type} by peer ${operation.peerId} on document ${operation.documentId}`
      )
    }

    // Verify final state
    console.log("Verifying final state...")
    const handles = Array.from(this.handles.values())
    const result = await this.verifier.verify(handles, this.testCase)
    if (!result.success) {
      throw new Error(`Verification failed: ${result.error}`)
    }
    console.log("Verification successful!")
    return result
  }

  private async applyOperation(operation: {
    type: OperationType
    peerId: PeerId
    documentId: DocumentId
    value?: any
    path?: string[]
  }) {
    const repo = this.repos.get(operation.peerId)
    if (!repo) {
      throw new Error(`Repo not found for peer ${operation.peerId}`)
    }

    const handle = await repo.find(operation.documentId)
    if (!handle) {
      throw new Error(`Document ${operation.documentId} not found`)
    }

    handle.change((doc: any) => {
      switch (operation.type) {
        case "TEXT_INSERT": {
          if (!operation.path || operation.value === undefined) {
            throw new Error("Missing path or value for TEXT_INSERT")
          }

          if (doc[operation.path[0]] === undefined) {
            doc[operation.path[0]] = ""
          }
          const path = operation.path.slice(0, -1)
          const index = operation.path[operation.path.length - 1]
          Automerge.splice(doc, path, Number(index), 0, operation.value)
          break
        }
        case "TEXT_DELETE": {
          if (!operation.path) {
            throw new Error("Missing path for TEXT_DELETE")
          }

          // Initialize the text field if it doesn't exist
          if (!doc[operation.path[0]]) {
            doc[operation.path[0]] = ""
          }

          const text = doc[operation.path[0]]
          const index = Number(operation.path[1])
          if (index < 0 || index >= text.length) {
            break
          }

          Automerge.splice(doc, [operation.path[0]], index, 1)
          break
        }
        case "MAP_SET": {
          if (!operation.path || !operation.value) {
            throw new Error("Missing path or value for MAP_SET")
          }
          doc[operation.path[0]] = operation.value
          break
        }
        case "LIST_INSERT": {
          if (!operation.path || !operation.value) {
            throw new Error("Missing path or value for LIST_INSERT")
          }
          const list = doc[operation.path[0]] || []
          list.splice(Number(operation.path[1]), 0, operation.value)
          break
        }
        case "LIST_DELETE": {
          if (!operation.path) {
            throw new Error("Missing path for LIST_DELETE")
          }
          const list = doc[operation.path[0]] || []
          const index = Number(operation.path[1])
          if (index < 0 || index >= list.length) {
            break
          }
          list.splice(index, 1)
          break
        }
      }
    })
  }
}
