import assert from "assert"
import { PeerId, Repo } from "@automerge/automerge-repo"
import { eventPromise } from "@automerge/automerge-repo/src/helpers/eventPromise"
import ws from "isomorphic-ws"
import { BrowserWebSocketClientAdapter } from "../src/BrowserWebSocketClientAdapter"
import { NodeWSServerAdapter } from "../src/NodeWSServerAdapter"
import { startServer } from "./utilities/WebSockets"

describe("Websocket Tests", () => {
  let repos: {
    serverRepo: Repo
    clientRepo: Repo
    server: ws.Server
  }

  const port = 8080
  before(async () => {
    const { socket, server } = await startServer(port)

    const serverRepo = new Repo({
      network: [new NodeWSServerAdapter(socket)],
      peerId: "server" as PeerId,
      sharePolicy: async () => false,
    })

    const clientRepo = new Repo({
      network: [new BrowserWebSocketClientAdapter("ws://localhost:" + port)],
      peerId: "client" as PeerId,
    })

    repos = { serverRepo, clientRepo, server: server as unknown as ws.Server }
  })

  after(() => repos.server.close())

  it("can sync a document from the client to the server", async () => {
    const { serverRepo, clientRepo } = repos

    const p = eventPromise(serverRepo, "document")

    const handle = clientRepo.create<{ foo: string }>()
    handle.change(d => {
      d.foo = "bar"
    })

    await p

    const serverHandle = serverRepo.find<{ foo: string }>(handle.documentId)
    await eventPromise(serverHandle, "change")
    const v = await serverHandle.value()

    assert.equal(v.foo, "bar")
  })

  it("can sync a document from a server (with a strict share policy) to the client when requested", async () => {
    const { serverRepo, clientRepo } = repos

    const handle = serverRepo.create<{ foo: string }>()
    const p = eventPromise(handle, "change")
    handle.change(d => {
      d.foo = "bach"
    })

    await p

    const clientHandle = clientRepo.find<{ foo: string }>(handle.documentId)
    await eventPromise(clientHandle, "change")
    const v = await clientHandle.value()

    assert.equal(v.foo, "bach")
  })
})
