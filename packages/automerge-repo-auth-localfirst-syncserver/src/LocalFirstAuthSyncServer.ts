import { PeerId, Repo } from "@automerge/automerge-repo"
import { LocalFirstAuthProvider } from "@automerge/automerge-repo-auth-localfirst"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import {
  Keyring,
  Keyset,
  KeysetWithSecrets,
  ServerWithSecrets,
  Team,
  castServer,
  createKeyset,
  redactKeys,
} from "@localfirst/auth"
import bodyParser from "body-parser"
import cors from "cors"
import express, { ErrorRequestHandler } from "express"
import fs from "fs"
import { Server as HttpServer } from "http"
import path from "path"
import { WebSocketServer } from "ws"
import { debug } from "./debug.js"

/**
 * This is a sync server for use with automerge-repo and the LocalFirstAuthProvider.
 *
 * The intended workflow for a client application is:
 * - Create a team
 * - GET `/keys` to obtain the server's public keys
 * - Add the server with its public keys to the team
 * - POST to `/teams` to send the team graph and keys to the server
 *
 * At this point anyone on the team can use automerge-repo with a LocalFirstAuthProvider to
 * authenticate with the server.
 */
export class LocalFirstAuthSyncServer {
  socket: WebSocketServer
  server: HttpServer
  host: string
  storageDir: string
  publicKeys: Keyset

  log = debug

  constructor(
    /**
     * A unique name for this server - probably its domain name or IP address. This should match the
     * name added to the localfirst/auth team.
     */
    host: string
  ) {
    this.host = host
    this.log.extend(host)
  }

  async listen(
    options: {
      port?: number
      storageDir?: string
      silent?: boolean
    } = {}
  ) {
    return new Promise<void>((resolve, reject) => {
      const {
        port = 3000,
        storageDir = "automerge-repo-data",
        silent = false,
      } = options
      this.storageDir = storageDir

      if (!fs.existsSync(storageDir)) fs.mkdirSync(storageDir)

      // Get keys from storage or create new ones
      const keys = this.#getKeys()
      this.publicKeys = redactKeys(keys)

      // Create the socket we will use. localfirst/auth will use this to send and receive
      // authentication messages, and Automerge Repo will use it to send and receive sync messages
      this.socket = new WebSocketServer({ noServer: true })

      this.socket.on("close", (payload: any) => {
        this.close(payload)
      })

      // Set up the auth provider
      const server: ServerWithSecrets = { host: this.host, keys }
      const user = castServer.toUser(server)
      const device = castServer.toDevice(server)
      const peerId = this.host as PeerId
      const storage = new NodeFSStorageAdapter(storageDir)
      const auth = new LocalFirstAuthProvider({ user, device, storage })

      // Set up the repo
      const adapter = new NodeWSServerAdapter(this.socket)
      const _repo = new Repo({
        peerId,
        // Use the auth provider to wrap our network adapter
        network: [auth.wrap(adapter)],
        // Use the same storage that the auth provider uses
        storage,
        // Since this is a server, we don't share generously — meaning we only sync documents they
        // already know about and can ask for by ID.
        sharePolicy: async peerId => false,
      })

      // Set up the server
      const confirmation = `👍 Sync server for Automerge Repo + localfirst/auth running`

      const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
        console.error(err.stack)
        res.status(500).send(err.message)
      }

      this.server = express()
        // parse application/json
        .use(bodyParser.json())

        // enable CORS
        // TODO: allow providing custom CORS config
        .use(cors())

        /** So you can visit the sync server in a browser to get confirmation that it's running */
        .get("/", (req, res) => {
          res.send(confirmation)
        })

        /** Endpoint to request the server's public keys. */
        .get("/keys", (req, res) => {
          this.log("GET /keys %o", req.body)
          res.send(this.publicKeys)
        })

        /** Endpoint to register a team. */
        .post("/teams", (req, res) => {
          this.log("POST /teams %o", req.body)
          const { serializedGraph, teamKeyring } = req.body as {
            serializedGraph: Uint8Array
            teamKeyring: Keyring
          }

          // rehydrate the team using the serialized graph and the keys passed in the request
          //! TODO: check that this team doesn't already exist, otherwise someone could slip you a fake team
          const team = new Team({
            source: objectToUint8Array(serializedGraph),
            context: { server },
            teamKeyring,
          })

          // add the team to our auth provider
          auth.addTeam(team)
          res.end()
        })

        .use(errorHandler)

        .listen(port, () => {
          if (!silent) {
            console.log(confirmation)
            console.log(`listening on port ${port}`)
          }
          resolve()
        })

      /**
       * When we successfully upgrade the client to a WebSocket connection, we emit a "connection"
       * event, which is handled by the NodeWSServerAdapter.
       */
      this.server.on("upgrade", (request, socket, head) => {
        this.socket.handleUpgrade(request, socket, head, socket => {
          this.socket.emit("connection", socket, request)
        })
      })
    })
  }

  close(payload: any) {
    this.log("socket closed %o", payload)
    this.server.close()
  }

  #getKeys = () => {
    const keysPath = path.join(this.storageDir, "__SERVER_KEYS.json")
    if (fs.existsSync(keysPath)) {
      // retrieve from storage
      const serializedKeys = fs.readFileSync(keysPath, "utf8")
      const keys = JSON.parse(serializedKeys) as KeysetWithSecrets
      return keys
    } else {
      // create & store new keys
      const keys = createKeyset({ type: "SERVER", name: this.host })
      fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2))
      return keys
    }
  }
}

/**
 *
 */
function objectToUint8Array(obj: { [key: number]: number }): Uint8Array {
  const arr = Object.values(obj)
  return new Uint8Array(arr)
}
