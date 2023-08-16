import { runAdapterTests } from "../../automerge-repo/src/helpers/tests/network-adapter-tests"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter"
import { startServer } from "./utilities/WebSockets"
import * as CBOR from "cbor-x"
import WebSocket, { AddressInfo } from "ws"
import { assert } from "chai"
import { PeerId, Repo } from "@automerge/automerge-repo"
import { once } from "events"

describe("Websocket adapters", async () => {
  let port = 8080

  runAdapterTests(async () => {
    let socket: WebSocket.Server | undefined = undefined
    let server: any

    while (socket === undefined) {
      try {
        ;({ socket, server } = await startServer(port))
      } catch (e: any) {
        if (e.code === "EADDRINUSE") {
          port++
        } else {
          throw e
        }
      }
    }

    const serverAdapter = new NodeWSServerAdapter(socket)

    const serverUrl = `ws://localhost:${port}`

    const aliceAdapter = new BrowserWebSocketClientAdapter(serverUrl)
    const bobAdapter = new BrowserWebSocketClientAdapter(serverUrl)

    const teardown = () => {
      server.close()
    }

    return { adapters: [serverAdapter, aliceAdapter, bobAdapter], teardown }
  })
})

describe("The BrowserWebSocketClientAdapter", () => {
  it("should advertise the protocol versions it supports in its join message", async () => {
    const { socket, server } = await startServer(0)
    let port = (server.address()!! as AddressInfo).port
    const serverUrl = `ws://localhost:${port}`
    const helloPromise = firstMessage(socket)

    const client = new BrowserWebSocketClientAdapter(serverUrl)
    const repo = new Repo({ network: [client], peerId: "browser" as PeerId })

    const hello = await helloPromise

    const message = CBOR.decode(hello as Uint8Array)
    assert.deepEqual(message, {
      type: "join",
      senderId: "browser",
      supportedProtocolVersions: ["1"],
    })
  })
})

describe("The NodeWSServerAdapter", () => {
  it("should send the negotiated protocol version in its hello message", async () => {
    const response = await serverHelloGivenClientHello({
      type: "join",
      senderId: "browser",
      supportedProtocolVersions: ["1"],
    })
    assert.deepEqual<any>(response, {
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
    assert.deepEqual<any>(response, {
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
    assert.deepEqual<any>(response, {
      type: "peer",
      senderId: "server",
      targetId: "browser",
      selectedProtocolVersion: "1",
    })
  })
})

async function serverHelloGivenClientHello(
  clientHello: Object
): Promise<Object | null> {
  const { socket, server } = await startServer(0)
  let port = (server.address()!! as AddressInfo).port
  const serverUrl = `ws://localhost:${port}`
  const adapter = new NodeWSServerAdapter(socket)
  const repo = new Repo({ network: [adapter], peerId: "server" as PeerId })

  const clientSocket = new WebSocket(serverUrl)
  await once(clientSocket, "open")
  const serverHelloPromise = once(clientSocket, "message")

  clientSocket.send(CBOR.encode(clientHello))

  const serverHello = await serverHelloPromise
  const message = CBOR.decode(serverHello[0] as Uint8Array)
  return message
}

async function firstMessage(
  socket: WebSocket.Server<any>
): Promise<Object | null> {
  return new Promise((resolve, reject) => {
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
}
