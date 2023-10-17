import { PeerId, Repo } from "@automerge/automerge-repo"
import assert from "assert"
import * as CBOR from "cbor-x"
import { once } from "events"
import http from "http"
import { describe, it } from "vitest"
import WebSocket, { AddressInfo } from "ws"
import { runAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter.js"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter.js"

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

    it("should send the negotiated protocol version in its hello message", async () => {
      const response = await serverResponse({
        type: "join",
        senderId: "browser",
        supportedProtocolVersions: ["1"],
      })
      assert.deepEqual(response, {
        type: "peer",
        senderId: "server",
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
        targetId: "browser",
        selectedProtocolVersion: "1",
      })
    })
  })
})

export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
