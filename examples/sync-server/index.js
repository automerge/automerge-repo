// @ts-check
import fs from "fs"
import crypto from "crypto"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "@automerge/automerge-repo"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import { default as Prometheus } from "prom-client"
import * as subductionModule from "@automerge/automerge-subduction"
import { Subduction } from "@automerge/automerge-subduction"
import {
  SubductionStorageBridge,
  initSubductionModule,
} from "@automerge/automerge-repo-subduction-bridge"

initSubductionModule(subductionModule)

/**
 * Simple Ed25519 signer for Node.js using the crypto module.
 * Generates a new key pair on creation (no persistence).
 */
class NodeSigner {
  #privateKey
  #publicKey

  constructor() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519")
    this.#privateKey = privateKey
    this.#publicKey = publicKey
  }

  /**
   * Sign a message and return the 64-byte Ed25519 signature.
   * @param {Uint8Array} message
   * @returns {Uint8Array}
   */
  sign(message) {
    const signature = crypto.sign(null, Buffer.from(message), this.#privateKey)
    return new Uint8Array(signature)
  }

  /**
   * Get the 32-byte Ed25519 verifying (public) key.
   * @returns {Uint8Array}
   */
  verifyingKey() {
    // Export the public key in raw format (32 bytes for Ed25519)
    const exported = this.#publicKey.export({ type: "spki", format: "der" })
    // Ed25519 SPKI format has 12 bytes of header, then 32 bytes of key
    return new Uint8Array(exported.slice(-32))
  }
}

const registry = new Prometheus.Registry()
Prometheus.collectDefaultMetrics({ register: registry })

const buckets = Prometheus.linearBuckets(0, 1000, 60)

const metrics = {
  docLoaded: new Prometheus.Histogram({
    name: "automerge_repo_doc_loaded_duration_millis",
    help: "Duration of loading a document",
    buckets,
    registers: [registry],
  }),
  receiveSyncMessage: new Prometheus.Histogram({
    name: "automerge_repo_receive_sync_message_duration_millis",
    help: "Duration of receiving a sync message",
    buckets,
    registers: [registry],
  }),
  numOps: new Prometheus.Histogram({
    name: "automerge_repo_num_ops",
    help: "Number of operations in a document",
    buckets: Prometheus.exponentialBuckets(1, 2, 20),
    registers: [registry],
  }),
}

export class Server {
  /** @type WebSocketServer */
  #socket

  /** @type ReturnType<import("express").Express["listen"]> */
  #server

  /** @type {((value: any) => void)[]} */
  #readyResolvers = []

  #isReady = false

  constructor() {
    const dir = "automerge-sync-server-data"
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir)
    }

    this.#socket = new WebSocketServer({ noServer: true })

    const PORT =
      process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
    const app = express()
    app.use(express.static("public"))

    const signer = new NodeSigner()
    const storageAdapter = new NodeFSStorageAdapter(dir)
    const storage = new SubductionStorageBridge(storageAdapter)
    Subduction.hydrate(signer, storage).then((subduction) => {
      const serverRepo = new Repo({
        network: [],
        subduction,
      })
      // Observe metrics for prometheus and also log the events so log aggregators like loki can pick them up
      serverRepo.on("doc-metrics", (event) => {
        console.log(JSON.stringify(event))
        metrics.numOps.observe(event.numOps)
        if (event.type === "doc-loaded") {
          metrics.docLoaded.observe(event.durationMillis)
        } else if (event.type === "receive-sync-message") {
          metrics.receiveSyncMessage.observe(event.durationMillis)
        }
      })

      app.get("/", (req, res) => {
        res.send(`👍 @automerge/example-sync-server is running`)
      })

      // In a real server this endpoint would be authenticated or not event part of the same express app
      app.get("/prometheus_metrics", async (req, res) => {
        res.set("Content-Type", registry.contentType)
        res.end(await registry.metrics())
      })

      this.#server = app.listen(PORT, () => {
        console.log(`Listening on port ${PORT}`)
        this.#isReady = true
        this.#readyResolvers.forEach((resolve) => resolve(true))
      })

      this.#server.on("upgrade", (request, socket, head) => {
        this.#socket.handleUpgrade(request, socket, head, (socket) => {
          this.#socket.emit("connection", socket, request)
        })
      })
    })
  }

  async ready() {
    if (this.#isReady) {
      return true
    }

    return new Promise((resolve) => {
      this.#readyResolvers.push(resolve)
    })
  }

  close() {
    this.#socket.close()
    this.#server.close()
  }
}

new Server()
