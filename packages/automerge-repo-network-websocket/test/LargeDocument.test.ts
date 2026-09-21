import { next as A } from "@automerge/automerge"
import { PeerId, Repo } from "@automerge/automerge-repo"
import { describe, expect, it, vi } from "vitest"
import http from "http"
import { WebSocketServer } from "ws"
import { getPortPromise as getAvailablePort } from "portfinder"
import { WebSocketClientAdapter } from "../src/WebSocketClientAdapter.js"
import { WebSocketServerAdapter } from "../src/WebSocketServerAdapter.js"

describe("large document over websocket", () => {
  // ws 8.21.3 lowered maxFragments to 16. A message is one frame unless the
  // sender fragments, and this adapter does not enable permessage-deflate.
  it("syncs a multi-megabyte document in one frame", async () => {
    const port = await getAvailablePort({ port: 3310 })
    const server = http.createServer()
    const wss = new WebSocketServer({ server })
    await new Promise<void>(r => server.listen(port, r))
    const serverAdapter = new WebSocketServerAdapter(wss)
    const serverRepo = new Repo({
      network: [serverAdapter],
      peerId: "server" as PeerId,
    })

    const clientAdapter = new WebSocketClientAdapter(`ws://localhost:${port}`)
    const clientRepo = new Repo({
      network: [clientAdapter],
      peerId: "client" as PeerId,
    })

    // ~4 MB of text in one document
    await Promise.all([
      new Promise<void>(r =>
        clientRepo.networkSubsystem.once("peer", () => r())
      ),
      new Promise<void>(r =>
        serverRepo.networkSubsystem.once("peer", () => r())
      ),
    ])

    // Unique per block, or automerge deduplicates it down to nothing.
    let seed = 1
    const block = () => {
      let out = ""
      for (let i = 0; i < 512; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        out += seed.toString(36)
      }
      return out
    }
    const handle = clientRepo.create<{ blocks: string[] }>({ blocks: [] })
    handle.change(d => {
      for (let i = 0; i < 1000; i++) d.blocks.push(block())
    })
    const bytes = A.save(handle.doc()!).length

    const onServer = await serverRepo.find<{ blocks: string[] }>(handle.url)
    expect(bytes).toBeGreaterThan(1_000_000)
    await vi.waitFor(() => expect(onServer.doc()?.blocks.length).toBe(1000), {
      timeout: 20000,
    })

    wss.close()
    server.close()
  }, 30000)
})
