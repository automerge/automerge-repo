import fs from "fs"
import express from "express"
import { Server as HttpServer } from "http"
import { WebSocketServer } from "ws"
import { PeerId, Repo, RepoConfig } from "@automerge/automerge-repo"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"
import path from "path"
import {
  KeysetWithSecrets,
  Team,
  createKeyset,
  redactKeys,
} from "@localfirst/auth"

const STORAGE_DIR = "automerge-sync-server-data"

export class Server {
  #socket: WebSocketServer
  #server: HttpServer

  #isReady = false

  constructor(host: string) {
    if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR)

    const keys = getServerKeys(host)

    this.#socket = new WebSocketServer({ noServer: true })

    const PORT =
      process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030
    const app = express()
    app.use(express.static("public"))

    // TODO: localfirst/auth could shield us from this nonsense of casting a
    // server as a fake user and a fake device.
    const userId = host
    const userName = host
    const deviceName = host
    const authContext = {
      user: { userId, userName, keys },
      device: { userId, deviceName, keys },
    }

    const auth = new LocalFirstAuthProvider(authContext)

    const config = {
      peerId: host as PeerId,
      network: [new NodeWSServerAdapter(this.#socket)],
      storage: new NodeFSStorageAdapter(STORAGE_DIR),
      auth,
    } as RepoConfig

    const _serverRepo = new Repo(config)

    app.get("/", (req, res) => {
      res.send(`👍 @automerge/example-sync-server is running`)
    })

    // endpoint to register a team
    app.post("/teams", (req, res) => {
      const { serializedGraph, teamKeyring } = req.body
      const team = new Team({
        source: serializedGraph,
        context: authContext,
        teamKeyring,
      })

      // we add our current device to the team chain
      team.join(teamKeyring)

      // we add the team to our auth provider
      auth.addTeam(team)

      // return the server's public keys
      const publicKeys = redactKeys(keys)
      res.send({ keys: publicKeys })
    })

    this.#server = app.listen(PORT, () => {
      console.log(`Listening on port ${PORT}`)
    })

    this.#server.on("upgrade", (request, socket, head) => {
      this.#socket.handleUpgrade(request, socket, head, socket => {
        this.#socket.emit("connection", socket, request)
      })
    })
  }

  close() {
    this.#socket.close()
    this.#server.close()
  }
}

const getServerKeys = (host: string) => {
  const keysPath = path.join(STORAGE_DIR, "__SERVER_KEYS.json")
  if (fs.existsSync(keysPath)) {
    // retrieve from storage
    const serializedKeys = fs.readFileSync(keysPath, "utf8")
    const keys = JSON.parse(serializedKeys) as KeysetWithSecrets
    return keys
  } else {
    // create & store new keys
    const keys = createKeyset({ type: "SERVER", name: host })
    fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2))
    return keys
  }
}
