import { runAdapterTests } from "@automerge/automerge-repo"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter"
import { startServer } from "./utilities/WebSockets"

describe("Websocket adapters", async () => {
  let port = 8080

  runAdapterTests(async () => {
    port += 1 // Increment port to avoid conflicts
    const { socket, server } = await startServer(port)
    const serverUrl = `ws://localhost:${port}`
    const serverAdapter = new NodeWSServerAdapter(socket)

    const aliceAdapter = new BrowserWebSocketClientAdapter(serverUrl)
    const bobAdapter = new BrowserWebSocketClientAdapter(serverUrl)

    const teardown = () => server.close()

    return { adapters: [serverAdapter, aliceAdapter, bobAdapter], teardown }
  })
})
