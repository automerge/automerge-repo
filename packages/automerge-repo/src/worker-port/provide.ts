/**
 * Port provisioning between tabs and a SharedWorker-hosted `Repo`.
 *
 * Chrome and Safari do not expose `Worker` inside a SharedWorker
 * (crbug.com/40695450), so the worker hosting the `Repo` cannot spawn the
 * WebSocket / IndexedDB proxy workers itself. A tab spawns them and
 * donates a `MessagePort`:
 *
 * ```
 * Tab ──── new SharedWorker(repo) ───────────► repo SharedWorker
 * Tab ──── new SharedWorker(io) ─────────────► io SharedWorker
 * Tab ──── transfer io.port over repo port ──► repo worker uses it
 * ```
 *
 * Repo-worker side:
 * ```ts
 * const io = makePortProvider()
 * onconnect = e => {
 *   io.attachClient(e.ports[0]) // alongside your own app handshake
 * }
 * new Repo({
 *   storage: new IndexedDBWorkerStorageAdapter("db", "docs", io.source),
 *   subductionWebsocketEndpoints: [
 *     new WorkerWebSocketEndpoint("wss://sync.example.com", { worker: io.source }),
 *   ],
 * })
 * ```
 *
 * Tab side:
 * ```ts
 * const repo = new SharedWorker(repoUrl, { type: "module", name: "repo" })
 * donatePort(repo.port, () => {
 *   const io = new SharedWorker(ioUrl, { type: "module", name: "io" })
 *   return io.port
 * })
 * ```
 *
 * Both io and repo SharedWorkers stay alive while *any* tab is open, so
 * the donated worker↔worker port outlives the donor tab. If the io worker
 * crashes, the donated port's `close` event fires (Chrome ≥132), consumers
 * drop it, and the provider broadcasts a `port-request` — every listening
 * tab re-spawns (`new SharedWorker` on the same URL/name converges on one
 * fresh instance) and re-donates.
 */

import type { WorkerPortLike } from "../subduction/worker-websocket/protocol.js"
import {
  PORT_PROVISION_CHANNEL,
  WORKER_PORT_PROTOCOL_VERSION,
  isPortProvisionMessage,
  workerPortVersionMismatch,
  workerPortVersionOk,
} from "./protocol.js"

/** Default {@link PortProvisionMessage.target} when only one port kind flows. */
const DEFAULT_TARGET = "default"

export interface PortProviderOptions {
  /** Disambiguates several provisioned ports on one client channel. */
  target?: string
}

/** Repo-worker side of port provisioning; see the module docs. */
export interface PortProvider {
  /**
   * Pass as the `worker` option of `WorkerWebSocketEndpoint` /
   * `IndexedDBWorkerStorageAdapter`. Resolves with the current live port,
   * or — when there is none — broadcasts a `port-request` to attached
   * clients and waits for a donation.
   */
  source: () => Promise<WorkerPortLike>

  /** Hand-deliver a port (skips the message protocol). */
  offer(port: WorkerPortLike): void

  /**
   * Watch a client (tab) port for `port-offer` messages and include it in
   * `port-request` broadcasts. Returns a detach function; a client whose
   * far side closes is pruned automatically.
   */
  attachClient(client: WorkerPortLike): () => void
}

export function makePortProvider({
  target = DEFAULT_TARGET,
}: PortProviderOptions = {}): PortProvider {
  let current: WorkerPortLike | null = null
  let waiters: Array<(port: WorkerPortLike) => void> = []
  const clients = new Set<WorkerPortLike>()

  const requestDonation = () => {
    for (const client of clients) {
      try {
        client.postMessage({
          channel: PORT_PROVISION_CHANNEL,
          v: WORKER_PORT_PROTOCOL_VERSION,
          type: "port-request",
          target,
        })
      } catch {
        clients.delete(client)
      }
    }
  }

  const offer = (port: WorkerPortLike) => {
    // A superseded `current` (e.g. the benign double donation when an
    // eager donor races a port-request) is left open, not closed:
    // consumers may have cached it, and both ends of a duplicate donation
    // converge on the same io worker anyway. It is dropped on `close`.
    current = port
    const onClose = () => {
      port.removeEventListener("close", onClose)
      if (current === port) current = null
    }
    port.addEventListener("close", onClose)
    port.start?.()
    const settled = waiters
    waiters = []
    for (const resolve of settled) resolve(port)
  }

  return {
    offer,

    source: () =>
      current
        ? Promise.resolve(current)
        : new Promise<WorkerPortLike>(resolve => {
            waiters.push(resolve)
            requestDonation()
          }),

    attachClient(client: WorkerPortLike) {
      clients.add(client)

      let complained = false
      const onMessage = (event: MessageEvent) => {
        const msg = event.data
        if (!isPortProvisionMessage(msg)) return
        if (!workerPortVersionOk(msg)) {
          // Deploy skew: refuse the donation — a port wired to a stale
          // proxy build would misbehave in far harder-to-debug ways.
          if (!complained) {
            complained = true
            console.error(workerPortVersionMismatch(msg))
          }
          return
        }
        if (msg.type !== "port-offer" || msg.target !== target) return
        // Prefer the embedded port (works in Node too); fall back to the
        // browser's transfer-list array for hand-rolled senders.
        const port = msg.port ?? event.ports?.[0]
        if (port) offer(port as WorkerPortLike)
      }

      const detach = () => {
        client.removeEventListener("message", onMessage)
        client.removeEventListener("close", detach)
        clients.delete(client)
      }

      client.addEventListener("message", onMessage)
      client.addEventListener("close", detach)
      client.start?.()

      // Someone is already waiting (e.g. the Repo was constructed before
      // the first tab connected): ask the newcomer immediately.
      if (waiters.length > 0 && !current) requestDonation()

      return detach
    },
  }
}

export interface DonatePortOptions {
  /** Must match the provider's `target`. */
  target?: string
  /**
   * Donate immediately on attach, not only on `port-request`. Default
   * true — the repo worker usually wants a port as soon as any tab is up.
   */
  eager?: boolean
}

/**
 * Tab side of port provisioning: donate a `MessagePort` to the context on
 * the far side of `client` (the repo SharedWorker), immediately and again
 * whenever it broadcasts a `port-request`. `createPort` runs per donation
 * — typically `new SharedWorker(ioUrl, ...).port`, which converges on the
 * same io worker instance across tabs while it lives, and respawns it
 * after a crash. Returns a detach function.
 */
export function donatePort(
  client: WorkerPortLike,
  createPort: () => MessagePort,
  { target = DEFAULT_TARGET, eager = true }: DonatePortOptions = {}
): () => void {
  const donate = () => {
    const port = createPort()
    client.postMessage(
      {
        channel: PORT_PROVISION_CHANNEL,
        v: WORKER_PORT_PROTOCOL_VERSION,
        type: "port-offer",
        target,
        port,
      },
      [port]
    )
  }

  let complained = false
  const onMessage = (event: MessageEvent) => {
    const msg = event.data
    if (!isPortProvisionMessage(msg)) return
    if (!workerPortVersionOk(msg)) {
      // Deploy skew: don't answer a stale provider's requests.
      if (!complained) {
        complained = true
        console.error(workerPortVersionMismatch(msg))
      }
      return
    }
    if (msg.type === "port-request" && msg.target === target) donate()
  }

  client.addEventListener("message", onMessage)
  client.start?.()
  if (eager) donate()

  return () => client.removeEventListener("message", onMessage)
}
