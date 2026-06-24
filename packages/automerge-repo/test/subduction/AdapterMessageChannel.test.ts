/**
 * Subduction tunneled over MessageChannel network adapters, registered
 * *dynamically* via `Repo.addSubductionAdapter` / `removeSubductionAdapter`.
 *
 * This mirrors the patchwork tab↔SharedWorker topology: one long-lived
 * "worker" Repo accepts a fresh MessageChannel per "tab" at runtime
 * (`role: "accept"`), and each tab connects over its own channel
 * (`role: "connect"`). The worker's single Subduction instance relays
 * sedimentrees between tabs — no classic automerge-repo sync, no WebSocket.
 *
 * Topology:
 *
 *   tabA ──MessageChannel──▸ worker Repo (accept, accept)
 *   tabB ──MessageChannel──▸   ↕ AdapterConnections relays tabA ⇄ tabB
 */

import { describe, it, expect, afterEach } from "vitest"
import { MessageChannelNetworkAdapter } from "../../../automerge-repo-network-messagechannel/src/index.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { pause } from "../../src/helpers/pause.js"

const SERVICE = "patchwork-tab-worker"

async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  timeoutMs: number,
  intervalMs = 25
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await pause(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms`)
}

describe("Subduction over MessageChannel (dynamic accept/connect)", () => {
  const cleanups: Array<() => void> = []
  afterEach(() => {
    for (const c of cleanups.reverse()) c()
    cleanups.length = 0
  })

  /** A worker Repo that accepts tab MessageChannels at runtime. */
  function startWorker() {
    const repo = new Repo({
      peerId: "worker" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      sharePolicy: async () => true,
    })
    return repo
  }

  /**
   * Wire a tab to the worker over a fresh MessageChannel. The worker side is
   * registered dynamically (the path patchwork's SharedWorker uses); the tab
   * side uses the constructor option.
   */
  function connectTab(name: string, worker: Repo) {
    const channel = new MessageChannel()
    const workerSideAdapter = new MessageChannelNetworkAdapter(channel.port1, {
      useWeakRef: false,
    })
    const tabSideAdapter = new MessageChannelNetworkAdapter(channel.port2, {
      useWeakRef: false,
    })

    worker.addSubductionAdapter(workerSideAdapter, SERVICE, "accept")

    const repo = new Repo({
      peerId: `${name}` as PeerId,
      // Ephemeral — the worker is the source of truth, exactly like the tab.
      network: [],
      sharePolicy: async () => true,
      subductionAdapters: [
        { adapter: tabSideAdapter, serviceName: SERVICE, role: "connect" },
      ],
    })

    cleanups.push(() => {
      worker.removeSubductionAdapter(workerSideAdapter)
      channel.port1.close()
      channel.port2.close()
    })

    return { repo, workerSideAdapter, tabSideAdapter, channel }
  }

  it("relays a document from one tab to another through the worker", async () => {
    const worker = startWorker()
    const tabA = connectTab("tabA", worker)
    const tabB = connectTab("tabB", worker)

    const handleA = tabA.repo.create<{ title: string }>()
    handleA.change(d => {
      d.title = "Hello from tab A"
    })

    const progress = tabB.repo.findWithProgress<{ title: string }>(
      handleA.url
    )
    await waitForCondition(() => {
      const s = progress.peek()
      return s.state === "ready" && s.handle.doc()?.title === "Hello from tab A"
    }, 5000)

    expect(progress.peek().state).toBe("ready")
  }, 10_000)

  it("propagates edits in both directions", async () => {
    const worker = startWorker()
    const tabA = connectTab("tabA", worker)
    const tabB = connectTab("tabB", worker)

    const handleA = tabA.repo.create<{ a?: string; b?: string }>()
    handleA.change(d => {
      d.a = "a-edit"
    })

    // Resolve via findWithProgress rather than a bare find(): a not-yet-synced
    // doc transitions through "unavailable" before its first sync round lands,
    // and find() rejects on that edge. (See ADR-008 / ModuleWatcher.findWithRetry.)
    const progressB = tabB.repo.findWithProgress<{ a?: string; b?: string }>(
      handleA.url
    )
    await waitForCondition(() => {
      const s = progressB.peek()
      return s.state === "ready" && s.handle.doc()?.a === "a-edit"
    }, 5000)
    const handleB = progressB.peek().handle!

    handleB.change(d => {
      d.b = "b-edit"
    })
    await waitForCondition(() => handleA.doc()?.b === "b-edit", 5000)

    expect(handleA.doc()?.a).toBe("a-edit")
    expect(handleA.doc()?.b).toBe("b-edit")
  }, 10_000)

  it("removeSubductionAdapter severs a tab without disturbing the others", async () => {
    const worker = startWorker()
    const tabA = connectTab("tabA", worker)
    const tabB = connectTab("tabB", worker)

    // Prove the link is live first.
    const doc1 = tabA.repo.create<{ v: string }>()
    doc1.change(d => {
      d.v = "before removal"
    })
    const progress1 = tabB.repo.findWithProgress<{ v: string }>(doc1.url)
    await waitForCondition(() => {
      const s = progress1.peek()
      return s.state === "ready" && s.handle.doc()?.v === "before removal"
    }, 5000)

    // Remove tab A on the worker side. Idempotent: calling twice must not throw.
    worker.removeSubductionAdapter(tabA.workerSideAdapter)
    worker.removeSubductionAdapter(tabA.workerSideAdapter)

    // A doc created on tab B reaches the worker and tab A's still-connected
    // peers, but not the severed tab A.
    const doc2 = tabB.repo.create<{ v: string }>()
    doc2.change(d => {
      d.v = "after removal"
    })

    const progressA = tabA.repo.findWithProgress<{ v: string }>(doc2.url)
    // Give it well beyond a normal sync round; it must stay un-ready.
    await pause(1500)
    expect(progressA.peek().state).not.toBe("ready")
  }, 15_000)
})
