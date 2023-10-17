import { runAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests.js"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter.js"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter.js"
import { startServer } from "./utilities/WebSockets.js"
import * as CBOR from "cbor-x"
import WebSocket, { AddressInfo } from "ws"
import assert from "assert"
import { PeerId, Repo } from "@automerge/automerge-repo"
import { once } from "events"
import { describe, it } from "vitest"

describe("Websocket adapters", async () => {
  // run adapter acceptance tests
  runAdapterTests(async () => {
    // set up server adapter
    const { socket, server, port } = await startServerOnNextAvailablePort(8000)
    const serverAdapter = new NodeWSServerAdapter(socket)

    // set up client adapters: both alice and bob are connected to the server
    const serverUrl = `ws://localhost:${port}`
    const aliceAdapter = new BrowserWebSocketClientAdapter(serverUrl)
    const bobAdapter = new BrowserWebSocketClientAdapter(serverUrl)

    const teardown = () => {
      server.close()
    }

    return { adapters: [aliceAdapter, serverAdapter, bobAdapter], teardown }
  })

  describe("BrowserWebSocketClientAdapter", () => {
    it("should advertise the protocol versions it supports in its join message", async () => {
      const { socket, server } = await startServer(0)
      let port = (server.address()!! as AddressInfo).port
      const serverUrl = `ws://localhost:${port}`
      const helloPromise = firstMessage(socket)

      const client = new BrowserWebSocketClientAdapter(serverUrl)
      const _repo = new Repo({ network: [client], peerId: "browser" as PeerId })

      const encodedMessage = await helloPromise
      const message = CBOR.decode(encodedMessage as Uint8Array)
      assert.deepEqual(message, {
        type: "join",
        senderId: "browser",
        supportedProtocolVersions: ["1"],
      })
    })

    it("should announce disconnections", () => {})
  })

  describe("NodeWSServerAdapter", () => {
    it("should send the negotiated protocol version in its hello message", async () => {
      const response = await serverHelloGivenClientHello({
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
      const response = await serverHelloGivenClientHello({
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
      const response = await serverHelloGivenClientHello({
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
      const { socket, server } = await startServer(0)
      let port = (server.address()!! as AddressInfo).port
      const serverUrl = `ws://localhost:${port}`
      const _serverAdapter = new NodeWSServerAdapter(socket)
      const browserAdapter = new BrowserWebSocketClientAdapter(serverUrl)

      const peerId = "testclient" as PeerId
      browserAdapter.connect(peerId)
      // simulate the reconnect timer firing before the other end has responded
      // (which works here because we haven't yielded to the event loop yet so
      // the server, which is on the same event loop as us, can't respond)
      browserAdapter.connect(peerId)
      // Now await, so the server responds on the first socket, if the listeners
      // are cleaned up correctly we shouldn't throw
      await pause(1)
    })
  })
})

const serverHelloGivenClientHello = async (clientHello: Object) => {
  const { socket, server } = await startServer(0)
  let port = (server.address()!! as AddressInfo).port
  const serverUrl = `ws://localhost:${port}`
  const adapter = new NodeWSServerAdapter(socket)
  const _repo = new Repo({ network: [adapter], peerId: "server" as PeerId })

  const clientSocket = new WebSocket(serverUrl)
  await once(clientSocket, "open")
  const serverHelloPromise = once(clientSocket, "message")

  clientSocket.send(CBOR.encode(clientHello))

  const serverHello = await serverHelloPromise
  const message = CBOR.decode(serverHello[0] as Uint8Array)
  return message
}

const firstMessage = async (socket: WebSocket.Server<any>) =>
  new Promise((resolve, reject) => {
    socket.once("connection", ws => {
      ws.once("message", (message: any) => {
        resolve(message)
      })
      ws.once("error", (error: any) => {
        reject(error)
      })
    })
    socket.once("error", error => {
      reject(error)
    })
  })

const startServerOnNextAvailablePort = async (port: number = 8080) => {
  try {
    const { socket, server } = await startServer(port)
    return { socket, server, port }
  } catch (e: any) {
    if (e.code === "EADDRINUSE") return startServerOnNextAvailablePort(port + 1)
    throw e
  }
}

export const pause = (t = 0) =>
  new Promise<void>(resolve => setTimeout(() => resolve(), t))
