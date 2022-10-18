import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import { Repo } from "automerge-repo"
import { NodeWSServerAdapter } from "automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "automerge-repo-storage-nodefs"
import os from "os"

const dir = ".amrg"
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir)
}

var hostname = os.hostname()

const wsServer = new WebSocketServer({ noServer: true })
const config = {
  network: [new NodeWSServerAdapter(wsServer)],
  storage: new NodeFSStorageAdapter(),
  peerId: `storage-server-${hostname}`,
  sharePolicy: (peerId) => false,
}

const PORT = 3030
const serverRepo = new Repo(config)
const app = express()
app.use(express.static("public"))

app.get("/", (req, res) => {
  res.send("Hello World")
})

const server = app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})

server.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (socket) => {
    wsServer.emit("connection", socket, request)
  })
})
