import { runSubductionNetworkAdapterTests } from "@automerge/automerge-repo-subduction/helpers/tests/subduction-network-adapter-tests.js"
import { WebSocketServer } from "ws"
import { WebSocketSubductionNetworkAdapter } from "../src/index.js"

runSubductionNetworkAdapterTests(async () => {
  const server = new WebSocketServer({ port: 0 })
  await new Promise<void>(resolve => server.once("listening", resolve))
  const { port } = server.address() as { port: number }
  const adapter = new WebSocketSubductionNetworkAdapter(
    `ws://127.0.0.1:${port}`,
    { retry: { initialMs: 10, maxMs: 20 } }
  )
  return {
    adapter,
    teardown: () =>
      new Promise<void>(resolve => {
        for (const client of server.clients) client.terminate()
        server.close(() => resolve())
      }),
  }
}, "WebSocketSubductionNetworkAdapter")
