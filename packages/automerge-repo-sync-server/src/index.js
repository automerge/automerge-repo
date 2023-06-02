import fs from "fs"
import express from "express"
import { WebSocketServer } from "ws"
import https from "https"
import http from "http"

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
const PORT = process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030

const app = express()
app.use(express.static("public"))

const config = {
  network: [new NodeWSServerAdapter(wsServer)],
  storage: new NodeFSStorageAdapter(),
  peerId: `storage-server-${hostname}`,
  // Since this is a server, we don't share generously — meaning we only sync documents they already
  // know about and can ask for by ID.
  sharePolicy: async (peerId) => false,
}
const serverRepo = new Repo(config)

app.get("/", (req, res) => {
  res.send(`👍 automerge-repo-sync-server is running`)
})


const httpServer = http.createServer(app).listen(PORT, () => {
  console.log(`Listening on port ${PORT}`)
})


// start https server
let sslOptions = {
   key: fs.readFileSync('key.pem'),
   cert: fs.readFileSync('cert.pem')
}

const httpsServer = https.createServer(sslOptions, app).listen(443, () => {
  console.log(`Listening for HTTPS on port 443`)
})

httpServer.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (socket) => {
    wsServer.emit("connection", socket, request)
  })
})

httpsServer.on("upgrade", (request, socket, head) => {
  wsServer.handleUpgrade(request, socket, head, (socket) => {
	  console.log(request, socket, head)
    wsServer.emit("connection", socket, request)
  })
})

