import { describe, expect, it, vi } from "vitest"
import { Repo } from "../src/Repo.js"
import { PeerId } from "../src/types.js"
import { DummyNetworkAdapter } from "../src/helpers/DummyNetworkAdapter.js"
import { DocSyncStatus, ConnectionStatus } from "../src/SyncStatus.js"
import connectRepos from "./helpers/connectRepos.js"
import pause from "./helpers/pause.js"
import { waitFor } from "./helpers/waitFor.js"
import { TestDoc } from "./types.js"

describe("Observability", () => {
  // -- Helpers --

  const setupTwoPeers = async () => {
    const alice = new Repo({ peerId: "alice" as PeerId })
    const bob = new Repo({ peerId: "bob" as PeerId })
    await connectRepos(alice, bob)
    return { alice, bob }
  }

  // -- Repo.syncStatus --

  describe("Repo.syncStatus", () => {
    it("returns empty connections for unknown document", () => {
      const repo = new Repo({ peerId: "solo" as PeerId })
      const handle = repo.create<TestDoc>()
      // A document with no network has no sync connections
      const status = repo.syncStatus(handle.url)
      expect(status).toEqual({
        docId: handle.documentId,
        connections: [],
      })
    })

    it("returns connections after syncing with a peer", async () => {
      const { alice, bob } = await setupTwoPeers()

      const handle = alice.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      // Wait for Bob to receive the document
      const bobHandle = await bob.find<TestDoc>(handle.url)

      const status = alice.syncStatus(handle.url)
      expect(status.docId).toEqual(handle.documentId)
      expect(status.connections.length).toBeGreaterThanOrEqual(1)

      const bobConn = status.connections.find(
        c => c.peerId === ("bob" as PeerId)
      )
      expect(bobConn).toBeDefined()
      expect(bobConn!.state).toEqual("has")
    })

    it("includes sharedHeads after sync completes", async () => {
      const { alice, bob } = await setupTwoPeers()

      const handle = alice.create<TestDoc>()
      handle.change(d => {
        d.foo = "hello"
      })

      const bobHandle = await bob.find<TestDoc>(handle.url)

      // Give sync a moment to fully settle
      await pause(100)

      // After sync completes, sharedHeads should be populated
      // (theirHeads gets cleared once fully in sync)
      const status = bob.syncStatus(handle.url)
      const aliceConn = status.connections.find(
        c => c.peerId === ("alice" as PeerId)
      )
      expect(aliceConn).toBeDefined()
      expect(aliceConn!.sharedHeads).not.toBeNull()
      expect(aliceConn!.sharedHeads!.length).toBeGreaterThan(0)
    })

    it("includes message events", async () => {
      const { alice, bob } = await setupTwoPeers()

      const handle = alice.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      const bobHandle = await bob.find<TestDoc>(handle.url)
      await pause(50)

      const status = alice.syncStatus(handle.url)
      const bobConn = status.connections.find(
        c => c.peerId === ("bob" as PeerId)
      )
      expect(bobConn).toBeDefined()
      expect(bobConn!.events.length).toBeGreaterThan(0)

      const sentEvents = bobConn!.events.filter(e => e.type === "message_sent")
      const receivedEvents = bobConn!.events.filter(
        e => e.type === "message_received"
      )
      expect(sentEvents.length).toBeGreaterThan(0)
      expect(receivedEvents.length).toBeGreaterThan(0)

      // Events should have timestamps
      for (const event of bobConn!.events) {
        expect(event.timestamp).toBeInstanceOf(Date)
      }
    })
  })

  // -- Repo.onSyncStatusChange --

  describe("Repo.onSyncStatusChange", () => {
    it("immediately invokes callback with current status", () => {
      const repo = new Repo({ peerId: "solo" as PeerId })
      const handle = repo.create<TestDoc>()

      const statuses: DocSyncStatus[] = []
      const unsub = repo.onSyncStatusChange(handle.url, status => {
        statuses.push(status)
      })

      // Should have been called immediately
      expect(statuses.length).toBe(1)
      expect(statuses[0].docId).toEqual(handle.documentId)

      unsub()
    })

    it("fires on peer connection and sync", async () => {
      const alice = new Repo({ peerId: "alice" as PeerId })
      const handle = alice.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      const statuses: DocSyncStatus[] = []
      const unsub = alice.onSyncStatusChange(handle.url, status => {
        statuses.push(status)
      })

      const initialCount = statuses.length

      // Now connect a peer — should trigger status changes
      const bob = new Repo({ peerId: "bob" as PeerId })
      await connectRepos(alice, bob)

      const bobHandle = await bob.find<TestDoc>(handle.url)
      await pause(50)

      expect(statuses.length).toBeGreaterThan(initialCount)

      // The latest status should show bob as a connection
      const latest = statuses[statuses.length - 1]
      const bobConn = latest.connections.find(
        c => c.peerId === ("bob" as PeerId)
      )
      expect(bobConn).toBeDefined()

      unsub()
    })

    it("stops firing after unsubscribe", async () => {
      const alice = new Repo({ peerId: "alice" as PeerId })
      const handle = alice.create<TestDoc>()

      const statuses: DocSyncStatus[] = []
      const unsub = alice.onSyncStatusChange(handle.url, status => {
        statuses.push(status)
      })

      unsub()
      const countAfterUnsub = statuses.length

      // Connect a peer — should NOT trigger more callbacks
      const bob = new Repo({ peerId: "bob" as PeerId })
      await connectRepos(alice, bob)

      handle.change(d => {
        d.foo = "bar"
      })

      const bobHandle = await bob.find<TestDoc>(handle.url)
      await pause(50)

      expect(statuses.length).toBe(countAfterUnsub)
    })

    it("fires when peer document status changes", async () => {
      const { alice, bob } = await setupTwoPeers()

      const handle = alice.create<TestDoc>()

      const statuses: DocSyncStatus[] = []
      const unsub = alice.onSyncStatusChange(handle.url, status => {
        statuses.push(status)
      })

      handle.change(d => {
        d.foo = "update"
      })

      const bobHandle = await bob.find<TestDoc>(handle.url)
      await pause(50)

      // Should have seen transitions — at minimum the peer appearing
      // and status moving to "has"
      const hasStates = statuses.filter(s =>
        s.connections.some(
          c => c.peerId === ("bob" as PeerId) && c.state === "has"
        )
      )
      expect(hasStates.length).toBeGreaterThan(0)

      unsub()
    })
  })

  // -- Repo.peerStatuses --

  describe("Repo.peerStatuses", () => {
    it("returns empty when no peers connected", () => {
      const repo = new Repo({ peerId: "solo" as PeerId })
      expect(repo.peerStatuses()).toEqual({})
    })

    it("tracks connected peer", async () => {
      const { alice } = await setupTwoPeers()

      const statuses = alice.peerStatuses()
      const bobStatus = statuses["bob" as PeerId]
      expect(bobStatus).toBeDefined()
      expect(bobStatus.peerId).toEqual("bob" as PeerId)
      expect(bobStatus.state).toEqual("connected")
    })

    it("tracks peer connection events", async () => {
      const { alice } = await setupTwoPeers()

      const statuses = alice.peerStatuses()
      const bobStatus = statuses["bob" as PeerId]
      expect(bobStatus.events.length).toBeGreaterThan(0)

      const connectedEvents = bobStatus.events.filter(
        e => e.type === "connected"
      )
      expect(connectedEvents.length).toBe(1)
      expect(connectedEvents[0].timestamp).toBeInstanceOf(Date)
    })

    it("records message events after sync", async () => {
      const { alice, bob } = await setupTwoPeers()

      const handle = alice.create<TestDoc>()
      handle.change(d => {
        d.foo = "bar"
      })

      const bobHandle = await bob.find<TestDoc>(handle.url)
      await pause(50)

      const statuses = alice.peerStatuses()
      const bobStatus = statuses["bob" as PeerId]

      const sent = bobStatus.events.filter(e => e.type === "message_sent")
      const received = bobStatus.events.filter(
        e => e.type === "message_received"
      )
      expect(sent.length).toBeGreaterThan(0)
      expect(received.length).toBeGreaterThan(0)
    })
  })

  // -- peer-status-change event --

  describe("peer-status-change event", () => {
    it("fires when a peer connects", async () => {
      const alice = new Repo({ peerId: "alice" as PeerId })

      const events: { peerId: PeerId; status: ConnectionStatus }[] = []
      alice.on("peer-status-change", event => {
        events.push(event)
      })

      const bob = new Repo({ peerId: "bob" as PeerId })
      await connectRepos(alice, bob)

      const connectedEvents = events.filter(
        e =>
          e.peerId === ("bob" as PeerId) && e.status.state === "connected"
      )
      expect(connectedEvents.length).toBeGreaterThanOrEqual(1)
    })

    it("fires when a peer disconnects", async () => {
      const alice = new Repo({ peerId: "alice" as PeerId })
      const bob = new Repo({ peerId: "bob" as PeerId })

      const [leftToRight, rightToLeft] =
        DummyNetworkAdapter.createConnectedPair({ latency: 0 })
      alice.networkSubsystem.addNetworkAdapter(leftToRight)
      bob.networkSubsystem.addNetworkAdapter(rightToLeft)
      leftToRight.peerCandidate(bob.peerId)
      rightToLeft.peerCandidate(alice.peerId)
      await Promise.all([
        alice.networkSubsystem.whenReady(),
        bob.networkSubsystem.whenReady(),
      ])
      await pause(10)

      const events: { peerId: PeerId; status: ConnectionStatus }[] = []
      alice.on("peer-status-change", event => {
        events.push(event)
      })

      // Disconnect bob's adapter
      leftToRight.emit("peer-disconnected", {
        peerId: "bob" as PeerId,
      })

      const disconnectedEvents = events.filter(
        e =>
          e.peerId === ("bob" as PeerId) &&
          e.status.state === "disconnected"
      )
      expect(disconnectedEvents.length).toBe(1)
    })
  })
})
