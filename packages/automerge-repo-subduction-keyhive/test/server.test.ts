import { Repo, parseAutomergeUrl } from "@automerge/automerge-repo"
import { sedimentreeId } from "@automerge/automerge-repo/sedimentree"
import * as N from "@automerge/subduction"
import { Identifier, Power } from "@keyhive/keyhive/slim"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createServer, connect as dial } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocketSubductionNetworkAdapter } from "../../automerge-repo-subduction-network-websocket/src/index.js"
import {
  connect,
  createPeer,
  readerWithoutKeys,
  whenReady,
  type TestPeer,
} from "./helpers.js"

interface Note {
  text: string
}

const binary = process.env.SUBDUCTION_CLI
const seed = new Uint8Array(32).fill(7)

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => resolve((address as { port: number }).port))
    })
  })
}

/** Whether any file under `dir` contains `text`. */
function anyFileContains(dir: string, text: string): boolean {
  return readdirSync(dir, { recursive: true, withFileTypes: true }).some(
    entry =>
      entry.isFile() &&
      readFileSync(join(entry.parentPath, entry.name)).includes(text)
  )
}

function accepting(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = dial(port, "127.0.0.1")
    socket.on("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.on("error", () => resolve(false))
  })
}

describe.skipIf(!binary)("through a Subduction sync server", () => {
  const cleanup: (() => Promise<void> | void)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
  })

  async function startServer() {
    const port = await freePort()
    const dataDir = mkdtempSync(join(tmpdir(), "keyhive-server-"))
    const server: ChildProcess = spawn(
      binary!,
      [
        "server",
        "--socket",
        `127.0.0.1:${port}`,
        "--data-dir",
        dataDir,
        "--key-seed",
        Buffer.from(seed).toString("hex"),
      ],
      { stdio: "ignore" }
    )
    cleanup.push(() => {
      server.kill()
      rmSync(dataDir, { recursive: true, force: true })
    })
    await vi.waitFor(async () => expect(await accepting(port)).toBe(true), {
      timeout: 10000,
      interval: 100,
    })
    const signer = N.createMemorySigner(seed)
    return {
      dataDir,
      url: `ws://127.0.0.1:${port}`,
      peerId: signer.peerId(),
      key: signer.verifyingKey(),
    }
  }

  type Server = Awaited<ReturnType<typeof startServer>>

  async function joinServer(peer: TestPeer, server: Server) {
    peer.backend.addRelay(server.key)
    await peer.inner.subduction.connect(server.url, server.peerId)
    const repo = new Repo({ backend: peer.backend })
    cleanup.push(() => repo.shutdown())
    return repo
  }

  /** A peer that connects to `server` through its options, as an application does. */
  async function connectedPeer(server: Server) {
    const adapter = new WebSocketSubductionNetworkAdapter(server.url)
    const peer = await createPeer(undefined, {
      relays: [server.key],
      network: [adapter],
    })
    await adapter.connected()
    const repo = new Repo({ backend: peer.backend })
    cleanup.push(() => repo.shutdown())
    return { peer, repo }
  }

  it("shares an edited document between two clients", async () => {
    const server = await startServer()
    const [alice, bob] = [
      await connectedPeer(server),
      await connectedPeer(server),
    ]
    const [aliceRepo, bobRepo] = [alice.repo, bob.repo]

    const handle = await aliceRepo.create<Note>({ text: "first" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.peer.backend.keyhive().getExistingContactCard(),
        Power.edit()
      )

    const atBob = await whenReady<Note>(bobRepo, handle.url)
    expect(atBob.doc()).toEqual({ text: "first" })

    handle.change(doc => {
      doc.text = "from alice"
    })
    await vi.waitFor(
      () => expect(atBob.doc()).toEqual({ text: "from alice" }),
      {
        timeout: 15000,
      }
    )

    atBob.change(doc => {
      doc.text = "from bob"
    })
    await vi.waitFor(() => expect(handle.doc()).toEqual({ text: "from bob" }), {
      timeout: 15000,
    })
  }, 60000)

  it("lets a member read a document after its writer disconnects", async () => {
    const server = await startServer()
    const [alice, bob] = [await createPeer(), await createPeer()]
    const aliceRepo = await joinServer(alice, server)
    const handle = await aliceRepo.create<Note>({ text: "left on the server" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.keyhive().getExistingContactCard(),
        Power.read()
      )
    // Long enough for the document and the membership to reach the server.
    await new Promise(resolve => setTimeout(resolve, 8000))
    await aliceRepo.shutdown()

    const bobRepo = await joinServer(bob, server)
    const read = await bobRepo.find<Note>(handle.url, {
      signal: AbortSignal.timeout(20000),
    })
    expect(read.doc()).toEqual({ text: "left on the server" })
  }, 60000)

  it("syncs a document through a member's server that its creator never granted", async () => {
    const server = await startServer()
    const alice = await createPeer()
    const [bob, carol] = [
      await connectedPeer(server),
      await connectedPeer(server),
    ]
    const { disconnect } = await connect(alice, bob.peer)
    cleanup.push(disconnect)
    const aliceRepo = new Repo({ backend: alice.backend })
    cleanup.push(() => aliceRepo.shutdown())

    const handle = await aliceRepo.create<Note>({ text: "from alice" })
    for (const member of [bob, carol]) {
      await handle
        .keyhive()
        .addMemberFromContactCard(
          await member.peer.backend.keyhive().getExistingContactCard(),
          Power.read()
        )
    }
    await whenReady(bob.repo, handle.url)

    const atCarol = await whenReady<Note>(carol.repo, handle.url)
    expect(atCarol.doc()).toEqual({ text: "from alice" })
  }, 60000)

  it("reports a document as unavailable to a non-member", async () => {
    const server = await startServer()
    const [alice, bob, eve] = [
      await createPeer(),
      await createPeer(),
      await createPeer(),
    ]
    const [aliceRepo, bobRepo, eveRepo] = [
      await joinServer(alice, server),
      await joinServer(bob, server),
      await joinServer(eve, server),
    ]
    const handle = await aliceRepo.create<Note>({ text: "private" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.keyhive().getExistingContactCard(),
        Power.read()
      )
    await whenReady(bobRepo, handle.url)

    await expect(
      eveRepo.find(handle.url, { signal: AbortSignal.timeout(10000) })
    ).rejects.toThrow("is unavailable")

    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    expect((await eve.inner.subduction.getHeads(id)) ?? []).toEqual([])
  }, 60000)

  it("stores no plaintext at the server", async () => {
    const server = await startServer()
    const [alice, bob] = [await createPeer(), await createPeer()]
    const [aliceRepo, bobRepo] = [
      await joinServer(alice, server),
      await joinServer(bob, server),
    ]
    const handle = await aliceRepo.create<Note>({ text: "written by alice" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.keyhive().getExistingContactCard(),
        Power.edit()
      )
    const atBob = await whenReady<Note>(bobRepo, handle.url)
    atBob.change(doc => {
      doc.text = "written by bob"
    })
    await vi.waitFor(
      () => expect(handle.doc()).toEqual({ text: "written by bob" }),
      { timeout: 15000 }
    )

    expect(readdirSync(server.dataDir, { recursive: true })).not.toEqual([])
    expect(anyFileContains(server.dataDir, "written by alice")).toBe(false)
    expect(anyFileContains(server.dataDir, "written by bob")).toBe(false)
  }, 60000)

  it("hides edits made after a member is revoked when syncing through the server", async () => {
    const server = await startServer()
    const [alice, bob] = [await createPeer(), await createPeer()]
    const [aliceRepo, bobRepo] = [
      await joinServer(alice, server),
      await joinServer(bob, server),
    ]
    const handle = await aliceRepo.create<Note>({ text: "before" })
    await handle
      .keyhive()
      .addMemberFromContactCard(
        await bob.backend.keyhive().getExistingContactCard(),
        Power.read()
      )
    const atBob = await whenReady<Note>(bobRepo, handle.url)
    readerWithoutKeys(bob.keyhive)

    await handle
      .keyhive()
      .revokeMember(new Identifier(bob.signer.verifyingKey()))
    handle.change(doc => {
      doc.text = "after"
    })
    await aliceRepo.flush()

    const id = sedimentreeId(parseAutomergeUrl(handle.url).binaryDocumentId)
    await vi.waitFor(
      () => expect(bob.backend.pendingCount(id)).toBeGreaterThan(0),
      { timeout: 15000 }
    )
    // Long enough for several keyhive sync rounds to have run.
    await new Promise(resolve => setTimeout(resolve, 5000))
    expect(atBob.doc()).toEqual({ text: "before" })
  }, 60000)
})
