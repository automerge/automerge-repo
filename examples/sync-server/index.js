// @ts-check
import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "@automerge/automerge-repo"
import { WebSocketServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import { default as Prometheus } from "prom-client"
import os from "os"

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

    var hostname = os.hostname()

    this.#socket = new WebSocketServer({ noServer: true })

    const PORT =
      process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
    const app = express()
    app.use(express.static("public"))

    const config = {
      network: [new WebSocketServerAdapter(this.#socket)],
      storage: new NodeFSStorageAdapter(dir),
      /** @ts-ignore @type {(import("@automerge/automerge-repo").PeerId)}  */
      peerId: `storage-server-${hostname}`,
      // Since this is a server, we don't share generously — meaning we only sync documents they already
      // know about and can ask for by ID.
      sharePolicy: async () => false,
    }
    const serverRepo = new Repo(config)

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
