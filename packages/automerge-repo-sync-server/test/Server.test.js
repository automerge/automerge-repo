// @ts-check

import assert from "assert"
import { beforeEach } from "mocha"
import { WebSocket } from "ws"

import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { Repo } from "@automerge/automerge-repo"

describe("Sync Server Tests", () => {
  const PORT =
    process.env.PORT !== undefined ? parseInt(process.env.PORT) : 3030

  beforeEach(() => {})

  it("runs the server correctly", (done) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`)

    ws.on("open", () => {
      done()
    })
  })

  it("can sync a document with the server and get back the same document", (done) => {
    const repo = new Repo({
      network: [new BrowserWebSocketClientAdapter(`ws://localhost:${PORT}`)],
    })

    const repo2 = new Repo({
      network: [new BrowserWebSocketClientAdapter(`ws://localhost:${PORT}`)],
    })

    const handle = repo.create()

    handle.change((doc) => {
      doc.test = "hello world"
    })

    const handle2 = repo2.find(handle.documentId)

    handle2.value().then((doc) => {
      assert.equal(doc.test, "hello world")
      done()
    })
  })

  it("withholds existing documents from new peers until they request them", async () => {
    const repo = new Repo({
      network: [new BrowserWebSocketClientAdapter(`ws://localhost:${PORT}`)],
    })

    const handle = repo.create()

    handle.change((doc) => {
      doc.test = "hello world"
    })

    // wait to give the server time to sync the document
    await new Promise((resolve) => setTimeout(resolve, 100))

    const repo2 = new Repo({
      network: [new BrowserWebSocketClientAdapter(`ws://localhost:${PORT}`)],
    })

    assert.equal(Object.keys(repo2.handles).length, 0)

    const handle2 = repo2.find(handle.documentId)

    assert.equal(Object.keys(repo2.handles).length, 1)

    const doc = await handle2.value()

    assert.equal(doc.test, "hello world")
  })
})
