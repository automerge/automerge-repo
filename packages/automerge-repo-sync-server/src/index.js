// @ts-check
import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "@automerge/automerge-repo"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import os from "os"

const dir = ".amrg"
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir)
}

var hostname = os.hostname()

const wsServer = new WebSocketServer({ noServer: true })
const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
const app = express()
app.use(express.static("public"))

const config = {
  network: [new NodeWSServerAdapter(wsServer)],
  storage: new NodeFSStorageAdapter(),
  /** @ts-ignore @type {(import("automerge-repo").PeerId)}  */
  peerId: `storage-server-${hostname}`,
  // Since this is a server, we don't share generously — meaning we only sync documents they already
  // know about and can ask for by ID.
  sharePolicy: async () => false,
}
const serverRepo = new Repo(config)

app.get("/", (req, res) => {
  res.send(`👍 automerge-repo-sync-server is running`)
})

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})

server.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (socket) => {
    wsServer.emit("connection", socket, request)
  })
})
