import { next as A } from "@automerge/automerge"
import {
  AutomergeUrl,
  DocumentId,
  PeerId,
  Repo,
  SyncMessage,
  parseAutomergeUrl,
} from "@automerge/automerge-repo"
import { generateAutomergeUrl } from "@automerge/automerge-repo"
import { eventPromise } from "@automerge/automerge-repo/helpers/eventPromise.js"
import { headsAreSame } from "@automerge/automerge-repo/helpers/headsAreSame.js"
import { runNetworkAdapterTests } from "@automerge/automerge-repo/helpers/tests/network-adapter-tests.js"
import { DummyStorageAdapter } from "@automerge/automerge-repo/helpers/DummyStorageAdapter.js"
import assert from "assert"
import * as CBOR from "cbor-x"
import { once } from "events"
import http from "http"
import { getPortPromise as getAvailablePort } from "portfinder"
import { describe, it } from "vitest"
import WebSocket from "ws"
import { WebSocketClientAdapter } from "../src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../src/WebSocketServerAdapter.js"

describe("Websocket adapters", () => {
  const browserPeerId = "browser" as PeerId
  const serverPeerId = "server" as PeerId
  const documentId = parseAutomergeUrl(generateAutomergeUrl()).documentId

  runNetworkAdapterTests(async () => {
    const {
      clients: [aliceAdapter, bobAdapter],
      server,
      serverAdapter,
    } = await setup({ clientCount: 2 })

    const teardown = () => {
      server.close()
    }

    return { adapters: [aliceAdapter, serverAdapter, bobAdapter], teardown }
  })

  describe("WebSocketClientAdapter", () => {
    it("should advertise the protocol versions it supports in its join message", async () => {
      const {
        serverSocket: socket,
        clients: [browser],
      } = await setup()

      const helloPromise = new Promise((resolve, reject) => {
        socket.once("connection", ws => {
          ws.once("message", (message: any) => resolve(message))
        })
      })

      const _repo = new Repo({ network: [browser], peerId: browserPeerId })

      const encodedMessage = await helloPromise
      const message = CBOR.decode(encodedMessage as Uint8Array)
      assert.deepEqual(message, {
        type: "join",
        senderId: browserPeerId,
        peerMetadata: { storageId: undefined, isEphemeral: true },
        supportedProtocolVersions: ["1"],
      })
    })

    it("should connect and emit peers", async () => {
      const {
        serverAdapter,
        clients: [browserAdapter],
      } = await setup()

      const browserRepo = new Repo({
        network: [browserAdapter],
        peerId: browserPeerId,
      })

      const serverRepo = new Repo({
        network: [serverAdapter],
        peerId: serverPeerId,
      })

      await Promise.all([
        eventPromise(browserRepo.networkSubsystem, "peer"),
        eventPromise(serverRepo.networkSubsystem, "peer"),
      ])
    })

    it("should connect even when server is not initially available", async () => {
      const port = await getPort() //?
      const retryInterval = 100

      const browserAdapter = await setupClient({ port, retryInterval })

      const _browserRepo = new Repo({
        network: [browserAdapter],
        peerId: browserPeerId,
      })

      await pause(500)

      const { serverAdapter } = await setupServer({ port, retryInterval })
      const serverRepo = new Repo({
        network: [serverAdapter],
        peerId: serverPeerId,
      })

      await eventPromise(browserAdapter, "peer-candidate")
    })

    it("should reconnect after being disconnected", async () => {
      const port = await getPort()
      const retryInterval = 100

      const browser = await setupClient({ port, retryInterval })

      {
        const { server, serverSocket, serverAdapter } = await setupServer({
          port,
          retryInterval,
        })

        const _browserRepo = new Repo({
          network: [browser],
          peerId: browserPeerId,
        })

        const serverRepo = new Repo({
          network: [serverAdapter],
          peerId: serverPeerId,
        })

        await eventPromise(browser, "peer-candidate")

        // Stop the server
        serverAdapter.disconnect()
        server.close()
        serverSocket.close()

        await eventPromise(browser, "peer-disconnected")
      }

      {
        // Restart the server (on the same port)
        const { serverAdapter } = await setupServer({ port, retryInterval })

        const serverRepo = new Repo({
          network: [serverAdapter],
          peerId: serverPeerId,
        })

        //  The browserAdapter reconnects on its own
        await eventPromise(browser, "peer-candidate")
      }
    })

    it("should throw an error if asked to send a zero-length message", async () => {
      const {
        clients: [browser],
      } = await setup()
      const sendNoData = () => {
        browser.send({
          type: "sync",
          data: new Uint8Array(), // <- empty
          documentId,
          senderId: browserPeerId,
          targetId: serverPeerId,
        })
      }
      assert.throws(sendNoData, /zero/)
    })

    it("should throw an error if asked to send before ready", async () => {
      const port = await getPort()

      const serverUrl = `ws://localhost:${port}`

      const retry = 100
      const browser = new WebSocketClientAdapter(serverUrl, retry)

      const _browserRepo = new Repo({
        network: [browser],
        peerId: browserPeerId,
      })

      const server = http.createServer()
      const serverSocket = new WebSocket.Server({ server })

      await new Promise<void>(resolve => server.listen(port, resolve))
      const serverAdapter = new WebSocketServerAdapter(serverSocket, retry)

      const serverRepo = new Repo({
        network: [serverAdapter],
        peerId: serverPeerId,
      })

      const sendMessage = () => {
        browser.send({
          // @ts-ignore
          type: "foo",
          data: new Uint8Array([1, 2, 3]),
          documentId,
          senderId: browserPeerId,
          targetId: serverPeerId,
        })
      }
      assert.throws(sendMessage, /not ready/)

      // once the server is ready, we can send
      await eventPromise(browser, "peer-candidate")
      assert.doesNotThrow(sendMessage)
    })

    it("should correctly clear event handlers on reconnect", async () => {
      // This reproduces an issue where the WebSocketClientAdapter.connect
      // call registered event handlers on the websocket but didn't clear them
      // up again on a second call to connect. This combined with the reconnect
      // timer to produce the following sequence of events:
      //
      // - first call to connect creates a socket and registers an "open"
      //   handler. The "open" handler will attempt to send a join message
      // - The connection is slow, so the reconnect timer fires before "open",
      //   the reconnect timer calls connect again. this.socket is now a new socket
      // - The other end replies to the first socket, "open"
      // - The original "open" handler attempts to send a message, but on the new
      //   socket (because it uses `this.socket`), which isn't open yet, so we get an
      //   error that the socket is not ready
      const {
        clients: [browser],
      } = await setup()

      const peerId = "testclient" as PeerId
      browser.connect(peerId)

      // simulate the reconnect timer firing before the other end has responded
      // (which works here because we haven't yielded to the event loop yet so
      // the server, which is on the same event loop as us, can't respond)
      browser.connect(peerId)

      // Now yield, so the server responds on the first socket, if the listeners
      // are cleaned up correctly we shouldn't throw
      await pause(1)
    })
  })

  describe("WebSocketServerAdapter", () => {
    const serverResponse = async (clientHello: Object) => {
      const { serverSocket, serverUrl } = await setup({
        clientCount: 0,
      })
      const server = new WebSocketServerAdapter(serverSocket)
      const _serverRepo = new Repo({
        network: [server],
        peerId: serverPeerId,
      })

      const clientSocket = new WebSocket(serverUrl)
      await once(clientSocket, "open")
      const serverHelloPromise = once(clientSocket, "message")

      clientSocket.send(CBOR.encode(clientHello))

      const serverHello = await serverHelloPromise
      const message = CBOR.decode(serverHello[0] as Uint8Array)
      return message
    }

    async function messageOrTimeout(socket: WebSocket): Promise<Buffer | null> {
      return new Promise(resolve => {
        const timer = setTimeout(() => {
          resolve(null)
        }, 1000)
        socket.once("message", msg => {
          clearTimeout(timer)
          resolve(msg as Buffer)
        })
      })
    }

    it("should disconnect from a closed client", async () => {
      const {
        serverAdapter,
        clients: [browserAdapter],
      } = await setup()

      const _browserRepo = new Repo({
        network: [browserAdapter],
        peerId: browserPeerId,
      })

      const serverRepo = new Repo({
        network: [serverAdapter],
        peerId: serverPeerId,
      })

      await eventPromise(serverRepo.networkSubsystem, "peer")

      const disconnectPromise = new Promise<void>(resolve => {
        serverAdapter.on("peer-disconnected", () => resolve())
      })

      browserAdapter.socket!.close()

      await disconnectPromise
    })

    it("should disconnect from a client that doesn't respond to pings", async () => {
      const port = await getPort()

      const serverUrl = `ws://localhost:${port}`

      const retry = 100
      const browserAdapter = new WebSocketClientAdapter(serverUrl, retry)

      const server = http.createServer()
      const serverSocket = new WebSocket.Server({ server })

      await new Promise<void>(resolve => server.listen(port, resolve))
      const serverAdapter = new WebSocketServerAdapter(serverSocket, retry)

      const _browserRepo = new Repo({
        network: [browserAdapter],
        peerId: browserPeerId,
      })

      const serverRepo = new Repo({
        network: [serverAdapter],
        peerId: serverPeerId,
      })

      await eventPromise(serverAdapter, "peer-candidate")

      // Simulate the client not responding to pings
      browserAdapter.socket!.pong = () => {}

      await eventPromise(serverAdapter, "peer-disconnected")
    })

    it("should send the negotiated protocol version in its hello message", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: browserPeerId,
        supportedProtocolVersions: ["1"],
      })
      assert.deepEqual(response, {
        type: "peer",
        senderId: "server",
        peerMetadata: { storageId: undefined, isEphemeral: true },
        targetId: "browser",
        selectedProtocolVersion: "1",
      })
    })

    it("should return an error message if the protocol version is not supported", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: browserPeerId,
        supportedProtocolVersions: ["fake"],
      })
      assert.deepEqual(response, {
        type: "error",
        senderId: "server",
        targetId: "browser",
        message: "unsupported protocol version",
      })
    })

    it("should respond with protocol v1 if no protocol version is specified", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: browserPeerId,
      })
      assert.deepEqual(response, {
        type: "peer",
        senderId: "server",
        peerMetadata: { storageId: undefined, isEphemeral: true },
        targetId: "browser",
        selectedProtocolVersion: "1",
      })
    })

    it("should disconnect existing peers on reconnect before announcing them", async () => {
      // This test exercises a sync loop which is exposed in the following
      // sequence of events:
      //
      // 1. A document exists on both the server and the client with divergent
      //    heads (both sides have changes the other does not have)
      // 2. The client sends a sync message to the server
      // 3. The server responds, but for some reason the server response is
      //    dropped
      // 4. The client reconnects due to not receiving a response or a ping
      // 5. The peers exchange sync messages, but the server thinks it has
      //    already sent its changes to the client, so it doesn't sent them.
      // 6. The client notices that it doesn't have the servers changes so it
      //    asks for them
      // 7. The server responds with an empty sync message because it thinks it
      //    has already sent the changes
      //
      // 6 and 7 continue in an infinite loop. The root cause is the servers
      // failure to clear the sync state associated with the given peer when
      // it receives a new connection from the same peer ID.

      /**
       *  Create a new document, initialized with the given contents and return a
       *  storage containing that document as well as the URL and a fork of the
       *  document
       *
       *  @param contents - The contents to initialize the document with
       */
      async function initDocAndStorage<T extends Record<string, unknown>>(
        contents: T
      ): Promise<{
        storage: DummyStorageAdapter
        url: AutomergeUrl
        doc: A.Doc<T>
        documentId: DocumentId
      }> {
        const storage = new DummyStorageAdapter()
        const silentRepo = new Repo({ storage })
        const doc = A.from<T>(contents)
        const handle = silentRepo.create()
        handle.update(() => A.clone(doc))
        const { documentId } = parseAutomergeUrl(handle.url)
        await pause(150)
        return {
          url: handle.url,
          doc,
          documentId,
          storage,
        }
      }

      function assertIsPeerMessage(msg: Buffer | null) {
        if (msg == null) {
          throw new Error("expected a peer message, got null")
        }
        let decoded = CBOR.decode(msg)
        if (decoded.type !== "peer") {
          throw new Error(`expected a peer message, got type: ${decoded.type}`)
        }
      }

      function assertIsSyncMessage(
        forDocument: DocumentId,
        msg: Buffer | null
      ): SyncMessage {
        if (msg == null) {
          throw new Error("expected a peer message, got null")
        }
        let decoded = CBOR.decode(msg)
        if (decoded.type !== "sync") {
          throw new Error(`expected a peer message, got type: ${decoded.type}`)
        }
        if (decoded.documentId !== forDocument) {
          throw new Error(
            `expected a sync message for ${forDocument}, not for ${decoded.documentId}`
          )
        }
        return decoded
      }

      const { serverSocket: socket, serverUrl } = await setupServer()

      // Create a doc, populate a DummyStorageAdapter with that doc
      const { storage, url, doc, documentId } = await initDocAndStorage({
        foo: "bar",
      })

      // Create a copy of the document to represent the client state
      let clientDoc = A.clone<{ foo: string }>(doc)
      clientDoc = A.change(clientDoc, d => (d.foo = "qux"))

      // Now create a websocket sync server with the original document in it's storage
      const adapter = new WebSocketServerAdapter(socket)
      const repo = new Repo({
        network: [adapter],
        storage,
        peerId: serverPeerId,
      })

      // make a change to the handle on the sync server
      const handle = repo.find<{ foo: string }>(url)
      await handle.whenReady()
      handle.change(d => (d.foo = "baz"))

      // Okay, so now there is a document on both the client and the server
      // which has concurrent changes on each peer.

      // Simulate the initial websocket connection
      let clientSocket = new WebSocket(serverUrl)
      await once(clientSocket, "open")

      // Run through the client/server hello
      clientSocket.send(
        CBOR.encode({
          type: "join",
          senderId: "client",
          supportedProtocolVersions: ["1"],
        })
      )

      let response = await messageOrTimeout(clientSocket)
      assertIsPeerMessage(response)

      // Okay now we start syncing

      let clientState = A.initSyncState()
      let [newSyncState, message] = A.generateSyncMessage(
        clientDoc,
        clientState
      )
      clientState = newSyncState

      // Send the initial sync state
      clientSocket.send(
        CBOR.encode({
          type: "request",
          documentId,
          targetId: "server",
          senderId: "client",
          data: message,
        })
      )

      response = await messageOrTimeout(clientSocket)
      assertIsSyncMessage(documentId, response)

      // Now, assume either the network or the server is going slow, so the
      // server thinks it has sent the response above, but for whatever reason
      // it never gets to the client. In that case the reconnect timer in the
      // WebSocketClientAdapter will fire and we'll create a new
      // websocket and connect it. To simulate this we drop the above response
      // on the floor and start connecting again.

      clientSocket = new WebSocket(serverUrl)
      await once(clientSocket, "open")

      // and we also make a change to the client doc
      clientDoc = A.change(clientDoc, d => (d.foo = "quoxen"))

      // Run through the whole client/server hello dance again
      clientSocket.send(
        CBOR.encode({
          type: "join",
          senderId: "client",
          supportedProtocolVersions: ["1"],
        })
      )

      response = await messageOrTimeout(clientSocket)
      assertIsPeerMessage(response)

      // Now, we start syncing. If we're not buggy, this loop should terminate.
      while (true) {
        ;[clientState, message] = A.generateSyncMessage(clientDoc, clientState)
        if (message) {
          clientSocket.send(
            CBOR.encode({
              type: "sync",
              documentId,
              targetId: "server",
              senderId: "client",
              data: message,
            })
          )
        }
        const response = await messageOrTimeout(clientSocket)
        if (response) {
          const decoded = assertIsSyncMessage(documentId, response)
          ;[clientDoc, clientState] = A.receiveSyncMessage(
            clientDoc,
            clientState,
            decoded.data
          )
        }
        if (response == null && message == null) {
          break
        }
        // Make sure shit has time to happen
        await pause(50)
      }

      let localHeads = A.getHeads(clientDoc)
      let remoteHeads = handle.heads()
      if (!headsAreSame(localHeads, remoteHeads)) {
        throw new Error("heads not equal")
      }
    })
  })
})

// HELPERS

const setup = async (options: SetupOptions = {}) => {
  const {
    clientCount = 1,
    retryInterval = 1000,
    port = await getPort(),
  } = options

  const { server, serverAdapter, serverSocket, serverUrl } = await setupServer(
    options
  )
  const clients = await Promise.all(
    Array.from({ length: clientCount }).map(() =>
      setupClient({ retryInterval, port })
    )
  )
  return { serverSocket, server, port, serverUrl, clients, serverAdapter }
}

const setupServer = async (options: SetupOptions = {}) => {
  const {
    clientCount = 1,
    retryInterval = 1000,
    port = await getPort(),
  } = options
  const serverUrl = `ws://localhost:${port}`
  const server = http.createServer()
  const serverSocket = new WebSocket.Server({ server })
  await new Promise<void>(resolve => server.listen(port, resolve))
  const serverAdapter = new WebSocketServerAdapter(serverSocket, retryInterval)
  return { server, serverAdapter, serverSocket, serverUrl }
}

const setupClient = async (options: SetupOptions = {}) => {
  const {
    clientCount = 1,
    retryInterval = 1000,
    port = await getPort(),
  } = options
  const serverUrl = `ws://localhost:${port}`
  return new WebSocketClientAdapter(serverUrl, retryInterval)
}

const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))

const getPort = () => {
  const base = 3010
  return getAvailablePort({ port: base })
}

// TYPES

type SetupOptions = {
  clientCount?: number
  retryInterval?: number
  port?: number
}
