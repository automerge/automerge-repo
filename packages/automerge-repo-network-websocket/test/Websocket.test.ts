import { next as A } from "@automerge/automerge"
import {
  AutomergeUrl,
  DocumentId,
  PeerId,
  Repo,
  SyncMessage,
  parseAutomergeUrl,
} from "@automerge/automerge-repo"
import assert from "assert"
import * as CBOR from "cbor-x"
import { once } from "events"
import http from "http"
import { describe, it } from "vitest"
import WebSocket, { AddressInfo } from "ws"
import { runAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { DummyStorageAdapter } from "../../automerge-repo/test/helpers/DummyStorageAdapter.js"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter.js"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter.js"
import { headsAreSame } from "@automerge/automerge-repo/src/helpers/headsAreSame.js"

describe("Websocket adapters", () => {
  const setup = async (clientCount = 1) => {
    const server = http.createServer()
    const socket = new WebSocket.Server({ server })

    await new Promise<void>(resolve => server.listen(0, resolve))
    const { port } = server.address() as AddressInfo
    const serverUrl = `ws://localhost:${port}`

    const clients = [] as BrowserWebSocketClientAdapter[]
    for (let i = 0; i < clientCount; i++) {
      clients.push(new BrowserWebSocketClientAdapter(serverUrl))
    }

    return { socket, server, port, serverUrl, clients }
  }

  // run adapter acceptance tests
  runAdapterTests(async () => {
    const {
      clients: [aliceAdapter, bobAdapter],
      socket,
      server,
    } = await setup(2)
    const serverAdapter = new NodeWSServerAdapter(socket)

    const teardown = () => {
      server.close()
    }

    return { adapters: [aliceAdapter, serverAdapter, bobAdapter], teardown }
  })

  describe("BrowserWebSocketClientAdapter", () => {
    const firstMessage = async (socket: WebSocket.Server<any>) =>
      new Promise((resolve, reject) => {
        socket.once("connection", ws => {
          ws.once("message", (message: any) => resolve(message))
          ws.once("error", (error: any) => reject(error))
        })
        socket.once("error", error => reject(error))
      })

    it("should advertise the protocol versions it supports in its join message", async () => {
      const {
        socket,
        clients: [browser],
      } = await setup()

      const helloPromise = firstMessage(socket)

      const _repo = new Repo({
        network: [browser],
        peerId: "browser" as PeerId,
      })

      const encodedMessage = await helloPromise
      const message = CBOR.decode(encodedMessage as Uint8Array)
      assert.deepEqual(message, {
        type: "join",
        senderId: "browser",
        storageId: undefined,
        isEphemeral: true,
        supportedProtocolVersions: ["1"],
      })
    })

    it.skip("should announce disconnections", async () => {
      const {
        server,
        socket,
        clients: [browserAdapter],
      } = await setup()

      const _browserRepo = new Repo({
        network: [browserAdapter],
        peerId: "browser" as PeerId,
      })

      const serverAdapter = new NodeWSServerAdapter(socket)
      const _serverRepo = new Repo({
        network: [serverAdapter],
        peerId: "server" as PeerId,
      })

      const disconnectPromise = new Promise<void>(resolve => {
        browserAdapter.on("peer-disconnected", () => resolve())
      })

      server.close()
      await disconnectPromise
    })

    it("should correctly clear event handlers on reconnect", async () => {
      // This reproduces an issue where the BrowserWebSocketClientAdapter.connect
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
      browser.connect(peerId, undefined, true)

      // simulate the reconnect timer firing before the other end has responded
      // (which works here because we haven't yielded to the event loop yet so
      // the server, which is on the same event loop as us, can't respond)
      browser.connect(peerId, undefined, true)

      // Now yield, so the server responds on the first socket, if the listeners
      // are cleaned up correctly we shouldn't throw
      await pause(1)
    })
  })

  describe("NodeWSServerAdapter", () => {
    const serverResponse = async (clientHello: Object) => {
      const { socket, serverUrl } = await setup(0)
      const server = new NodeWSServerAdapter(socket)
      const _serverRepo = new Repo({
        network: [server],
        peerId: "server" as PeerId,
      })

      const clientSocket = new WebSocket(serverUrl)
      await once(clientSocket, "open")
      const serverHelloPromise = once(clientSocket, "message")

      clientSocket.send(CBOR.encode(clientHello))

      const serverHello = await serverHelloPromise
      const message = CBOR.decode(serverHello[0] as Uint8Array)
      return message
    }

    async function recvOrTimeout(socket: WebSocket): Promise<Buffer | null> {
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

    it("should send the negotiated protocol version in its hello message", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: "browser",
        supportedProtocolVersions: ["1"],
      })
      assert.deepEqual(response, {
        type: "peer",
        senderId: "server",
        storageId: undefined,
        isEphemeral: true,
        targetId: "browser",
        selectedProtocolVersion: "1",
      })
    })

    it("should return an error message if the protocol version is not supported", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: "browser",
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
        senderId: "browser",
      })
      assert.deepEqual(response, {
        type: "peer",
        senderId: "server",
        storageId: undefined,
        isEphemeral: true,
        targetId: "browser",
        selectedProtocolVersion: "1",
      })
    })

    /**
     *  Create a new document, initialized with the given contents and return a
     *  storage containign that document as well as the URL and a fork of the
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
      const silentRepo = new Repo({ storage, network: [] })
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
      const { socket, serverUrl } = await setup(0)

      // Create a doc, populate a DummyStorageAdapter with that doc
      const { storage, url, doc, documentId } = await initDocAndStorage({
        foo: "bar",
      })

      // Create a copy of the document to represent the client state
      let clientDoc = A.clone<{ foo: string }>(doc)
      clientDoc = A.change(clientDoc, d => (d.foo = "qux"))

      // Now create a websocket sync server with the original document in it's storage
      const adapter = new NodeWSServerAdapter(socket)
      const repo = new Repo({
        network: [adapter],
        storage,
        peerId: "server" as PeerId,
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

      let response = await recvOrTimeout(clientSocket)
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

      response = await recvOrTimeout(clientSocket)
      assertIsSyncMessage(documentId, response)

      // Now, assume either the network or the server is going slow, so the
      // server thinks it has sent the response above, but for whatever reason
      // it never gets to the client. In that case the reconnect timer in the
      // BrowserWebSocketClientAdapter will fire and we'll create a new
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

      response = await recvOrTimeout(clientSocket)
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
        const response = await recvOrTimeout(clientSocket)
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
      let remoteHeads = A.getHeads(handle.docSync())
      if (!headsAreSame(localHeads, remoteHeads)) {
        throw new Error("heads not equal")
      }
    })
  })
})

export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
