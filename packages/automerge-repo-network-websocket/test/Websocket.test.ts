import { runAdapterTests } from "automerge-repo-network-acceptance-tests"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter"
import { startServer } from "./utilities/WebSockets"

describe("Websocket adapters", async () => {
  let port = 8080

  const setup = async () => {
    port += 1 // Increment port to avoid conflicts
    const { socket, server } = await startServer(port)

    const serverAdapter = new NodeWSServerAdapter(socket)
    const clientAdapter = new BrowserWebSocketClientAdapter(
      `ws://localhost:${port}`
    )
    const teardown = () => {
      server.close()
    }

    return { clientAdapter, serverAdapter, teardown }
  }

  runAdapterTests(async () => {
    const { clientAdapter, serverAdapter, teardown } = await setup()
    return { adapters: [clientAdapter, serverAdapter], teardown }
  }, "forwards")

  runAdapterTests(async () => {
    const { clientAdapter, serverAdapter, teardown } = await setup()
    return { adapters: [serverAdapter, clientAdapter], teardown }
  }, "backwards")
})
