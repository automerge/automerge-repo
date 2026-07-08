/**
 * Port provisioning between "tabs" and a SharedWorker-hosted Repo,
 * simulated over `worker_threads` MessageChannels. Node ports fire the
 * same `close` event (Chrome ≥132) the production paths rely on.
 */
import { MessageChannel as NodeMessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it, vi } from "vitest"

import { startDriftProbe } from "../../src/worker-port/drift-probe.js"
import { createErrorRelay } from "../../src/worker-port/error-relay.js"
import {
  PORT_PROVISION_CHANNEL,
  WORKER_ERROR_CHANNEL,
  isWorkerStatsMessage,
  type WorkerErrorMessage,
  type WorkerStatsMessage,
} from "../../src/worker-port/protocol.js"
import { donatePort, makePortProvider } from "../../src/worker-port/provide.js"
import type { WorkerPortLike } from "../../src/subduction/worker-websocket/protocol.js"

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** Ports to close after each test so listeners never pin the event loop. */
const openPorts: Array<{ close(): void }> = []
const track = <T extends { close(): void }>(port: T): T => {
  openPorts.push(port)
  return port
}

const trackedChannel = () => {
  const channel = new NodeMessageChannel()
  track(channel.port1)
  track(channel.port2)
  return channel
}

afterEach(() => {
  for (const port of openPorts.splice(0)) port.close()
})

const asPort = (p: unknown) => p as WorkerPortLike

describe("makePortProvider / donatePort", () => {
  it("resolves source() with a directly offered port", async () => {
    const provider = makePortProvider()
    const pending = provider.source()

    const { port1 } = trackedChannel()
    provider.offer(asPort(port1))

    expect(await pending).toBe(port1)
    // Cached: no new waiters needed.
    expect(await provider.source()).toBe(port1)
  })

  it("donates eagerly across a client channel (tab → repo worker)", async () => {
    const provider = makePortProvider()
    // tabSide ↔ repoSide models the tab's connection to the repo worker.
    const { port1: tabSide, port2: repoSide } = trackedChannel()
    provider.attachClient(asPort(repoSide))

    // createPort must mint a fresh port per donation (a transferred port
    // is detached); remember each far end so we can find the live pair.
    const farEnds: Array<InstanceType<typeof NodeMessageChannel>["port2"]> = []
    donatePort(asPort(tabSide), () => {
      const donated = trackedChannel()
      farEnds.push(donated.port2)
      return donated.port1 as unknown as MessagePort
    })

    const got = await provider.source()
    // The transferred port is a fresh object, not reference-equal; verify
    // it is entangled with one of the donor's far ends.
    const received = new Promise(resolve => {
      got.addEventListener("message", e => resolve((e as MessageEvent).data))
      got.start?.()
    })
    for (const far of farEnds) far.postMessage("hi")
    expect(await received).toBe("hi")
  })

  it("re-requests a donation after the current port closes", async () => {
    const provider = makePortProvider()
    const { port1: tabSide, port2: repoSide } = trackedChannel()
    provider.attachClient(asPort(repoSide))

    let donations = 0
    donatePort(asPort(tabSide), () => {
      donations++
      return trackedChannel().port1 as unknown as MessagePort
    })

    // Let the eager donation land before asking, else the provider
    // broadcasts a port-request and a second (benign) donation races in.
    await tick()
    const first = await provider.source()
    expect(donations).toBe(1)

    // Simulate the io worker dying: close the far side of nothing — the
    // donated port itself is closed by closing what we hold.
    ;(first as unknown as { close(): void }).close()
    await tick()

    const second = await provider.source()
    expect(donations).toBe(2)
    expect(second).not.toBe(first)
  })

  it("asks a late-attaching client when a source() call is already waiting", async () => {
    const provider = makePortProvider()
    const pending = provider.source() // Repo constructed before any tab

    const { port1: tabSide, port2: repoSide } = trackedChannel()
    const donated = trackedChannel()
    // eager: false — this tab only answers explicit requests.
    donatePort(
      asPort(tabSide),
      () => donated.port1 as unknown as MessagePort,
      { eager: false }
    )

    provider.attachClient(asPort(repoSide))
    await expect(pending).resolves.toBeDefined()
  })

  it("routes by target", async () => {
    const io = makePortProvider({ target: "io" })
    const other = makePortProvider({ target: "other" })
    const { port1: tabSide, port2: repoSide } = trackedChannel()
    io.attachClient(asPort(repoSide))
    other.attachClient(asPort(repoSide))

    donatePort(
      asPort(tabSide),
      () => trackedChannel().port1 as unknown as MessagePort,
      { target: "io" }
    )

    await expect(io.source()).resolves.toBeDefined()
    let otherResolved = false
    void other.source().then(() => (otherResolved = true))
    await tick()
    expect(otherResolved).toBe(false)
  })
})

describe("protocol version skew", () => {
  it("the provider refuses an untagged port-offer and complains once", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const provider = makePortProvider()
      const { port1: tabSide, port2: repoSide } = trackedChannel()
      provider.attachClient(asPort(repoSide))

      let resolved = false
      void provider.source().then(() => (resolved = true))

      // A stale tab build donates without a version tag — twice.
      for (let i = 0; i < 2; i++) {
        const donated = trackedChannel()
        tabSide.postMessage(
          {
            channel: PORT_PROVISION_CHANNEL,
            type: "port-offer",
            target: "default",
            port: donated.port1,
          },
          [donated.port1]
        )
      }
      await tick()

      expect(resolved).toBe(false) // donation refused
      expect(errorSpy).toHaveBeenCalledTimes(1) // loud, but not spammy
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/version mismatch/)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("donatePort ignores an untagged port-request and complains", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const { port1: tabSide, port2: repoSide } = trackedChannel()
      let donations = 0
      donatePort(
        asPort(tabSide),
        () => {
          donations++
          return trackedChannel().port1 as unknown as MessagePort
        },
        { eager: false }
      )

      // A stale provider build requests without a version tag.
      repoSide.postMessage({
        channel: PORT_PROVISION_CHANNEL,
        type: "port-request",
        target: "default",
      })
      await tick()

      expect(donations).toBe(0)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0][0])).toMatch(/version mismatch/)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe("startDriftProbe", () => {
  it("stays silent when healthy, reports when the loop is blocked", async () => {
    const samples: WorkerStatsMessage[] = []
    const stop = startDriftProbe(s => samples.push(s), {
      intervalMs: 25,
      reportThresholdMs: 100,
    })
    try {
      // Healthy: several ticks, nothing crosses the threshold.
      await new Promise(r => setTimeout(r, 100))
      expect(samples).toHaveLength(0)

      // Block the event loop well past the threshold.
      const until = Date.now() + 150
      while (Date.now() < until) {
        /* busy-wait */
      }
      await new Promise(r => setTimeout(r, 50))

      expect(samples.length).toBeGreaterThanOrEqual(1)
      expect(samples[0].driftMs).toBeGreaterThanOrEqual(100)
      expect(isWorkerStatsMessage(samples[0])).toBe(true)
    } finally {
      stop()
    }
  })
})

describe("createErrorRelay", () => {
  it("fans unhandled errors out to registered ports and prunes closed ones", async () => {
    const scope = new EventTarget()
    const relay = createErrorRelay(scope)

    const received: WorkerErrorMessage[] = []
    const alive = {
      postMessage: (m: unknown) => received.push(m as WorkerErrorMessage),
      addEventListener: () => {},
    }
    const throwing = {
      postMessage: () => {
        throw new Error("detached port")
      },
      addEventListener: () => {},
    }
    relay.addPort(alive)
    relay.addPort(throwing)

    scope.dispatchEvent(new Event("error"))
    scope.dispatchEvent(new Event("unhandledrejection"))

    expect(received).toHaveLength(2)
    expect(received[0].channel).toBe(WORKER_ERROR_CHANNEL)
    expect(received[0].kind).toBe("error")
    expect(received[1].kind).toBe("unhandledrejection")

    // The throwing port was pruned on first failure; no further throws.
    scope.dispatchEvent(new Event("error"))
    expect(received).toHaveLength(3)

    relay.dispose()
    scope.dispatchEvent(new Event("error"))
    expect(received).toHaveLength(3)
  })
})
