import { beelay } from "@automerge/automerge"
import { afterEach, beforeEach, describe, it } from "vitest"
import { acceptWebsocket, connectClientWebsocket } from "../"
import express from "express"
import { WebSocketServer } from "ws"
import { createHash } from "crypto"
import { AddressInfo } from "net"
import assert from "assert"

describe("beelay websocket adapter", () => {
  let beelays: beelay.Beelay[] = []
  async function create(): Promise<beelay.Beelay> {
    const repo = await beelay.loadBeelay({
      storage: beelay.createMemoryStorageAdapter(),
      signer: beelay.createMemorySigner(),
    })
    beelays.push(repo)
    return repo
  }

  afterEach(async () => {
    await Promise.all(beelays.map(beelay => beelay.stop()))
    beelays = []
  })

  it("should sync", async () => {
    const clientRepo = await create()
    const serverRepo = await create()
    const doc = await clientRepo.createDoc({
      initialCommit: commit("hello"),
      otherParents: [{ type: "public" }],
    })

    const serverPort = await findFreePort()
    const server = makeServer(serverPort, serverRepo)
    connectClientWebsocket(clientRepo, `ws://localhost:${serverPort}`)

    await clientRepo.waitUntilSynced(serverRepo.peerId)

    assert(await clientRepo.loadDocument(doc))
  })

  it("should connect when the server comes up", async () => {
    const clientRepo = await create()
    const serverRepo = await create()
    const doc = await clientRepo.createDoc({
      initialCommit: commit("hello"),
      otherParents: [{ type: "public" }],
    })
    const serverPort = await findFreePort()
    connectClientWebsocket(clientRepo, `ws://localhost:${serverPort}`, {
      initialBackoffMs: 100,
    })
    await pause(200)
    const server = makeServer(serverPort, serverRepo)

    await clientRepo.waitUntilSynced(serverRepo.peerId)
  })
})

function makeServer(port: number, repo: beelay.Beelay) {
  const app = express()
  const server = app.listen(port)
  const beelaySocket = new WebSocketServer({ noServer: true })
  server.on("upgrade", (request, socket, head) => {
    beelaySocket.handleUpgrade(request, socket, head, socket => {
      beelaySocket.emit("connection", socket, request)
    })
  })
  acceptWebsocket(repo, "localhost", beelaySocket)
  return {
    socket: beelaySocket,
    shutdown: () => {
      server.close()
      beelaySocket.close()
    },
  }
}

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = express().listen(0, () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port as unknown as number))
    })
  })
}

function commit(contents: string, parents: string[] = []): beelay.Commit {
  const hash = createHash("sha256")
    .update(contents)
    .update(parents.join(""))
    .digest("hex")
  const contentsAsUint8Array = new Uint8Array(Buffer.from(contents, "utf-8"))
  return {
    parents,
    hash,
    contents: contentsAsUint8Array,
  }
}

async function pause(ms: number) {
  await new Promise(resolve => setTimeout(resolve, ms))
}
