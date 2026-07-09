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
 * Repo-worker side (a SharedWorker entry file). Note: one provider
 * feeding both storage and sync means the donated port's far side must
 * host **both** protocols — use the combined io entry
 * `@automerge/automerge-repo-storage-indexeddb/worker-io-shared` (the
 * single-purpose entries each serve one protocol; donating one of those
 * here would leave the other consumer stalling on init timeouts):
 * ```ts
 * import { Repo, WorkerWebSocketEndpoint } from "@automerge/automerge-repo/slim"
 * import { makePortProvider } from "@automerge/automerge-repo/worker-port"
 * import { IndexedDBWorkerStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb/worker-adapter"
 * // (initialize Automerge/Subduction wasm here — see the slim entrypoint docs)
 *
 * const io = makePortProvider()
 *
 * // `onconnect` is not in TS's lib types for module workers; go through
 * // the global scope explicitly (the shipped entries do the same):
 * const scope = globalThis as unknown as {
 *   onconnect: ((event: MessageEvent) => void) | null
 * }
 * scope.onconnect = e => {
 *   io.attachClient(e.ports[0]) // alongside your own app handshake
 * }
 *
 * const repo = new Repo({
 *   storage: new IndexedDBWorkerStorageAdapter("db", "docs", io.source),
 *   subductionWebsocketEndpoints: [
 *     new WorkerWebSocketEndpoint("wss://sync.example.com", { worker: io.source }),
 *   ],
 * })
 * ```
 *
 * Tab side. Spawn the io worker from a file in *your own source* so every
 * bundler resolves it — `import.meta.resolve` of a bare specifier inside
 * `new SharedWorker(...)` is not statically analyzable (Vite won't emit
 * the chunk). Create `io-worker.ts` next to this code containing exactly
 * `import "@automerge/automerge-repo-storage-indexeddb/worker-io-shared"`,
 * then:
 * ```ts
 * import { donatePort } from "@automerge/automerge-repo/worker-port"
 *
 * const repo = new SharedWorker(new URL("./repo-worker.ts", import.meta.url), {
 *   type: "module",
 *   name: "repo",
 * })
 * donatePort(repo.port, () => {
 *   const io = new SharedWorker(new URL("./io-worker.ts", import.meta.url), {
 *     type: "module",
 *     name: "automerge-io",
 *   })
 *   return io.port
 * })
 * ```
 *
 * Both io and repo SharedWorkers stay alive while *any* tab is open, so
 * the donated worker↔worker port outlives the donor tab. If the io worker
 * crashes, the donated port's `close` event fires (Chrome ≥132), consumers
 * drop it, and the provider broadcasts a `port-request` — every listening
 * tab re-spawns (`new SharedWorker` on the same URL/name converges on one
 * fresh instance) and re-donates. (`donatePort` answers `port-request`s
 * for as long as the tab lives; if the *repo* worker itself restarts, run
 * `donatePort` against the respawned worker's port — donations into the
 * dead port are silent no-ops.) For close-event gaps — a crash racing the
 * donation, or browsers below the close floor — see
 * {@link PortProvider.invalidate}.
 */

import type { WorkerPortLike } from "../subduction/worker-websocket/protocol.js"
import {
  PORT_PROVISION_CHANNEL,
  WORKER_ERROR_CHANNEL,
  WORKER_PORT_PROTOCOL_VERSION,
  isPortProvisionMessage,
  workerPortVersionMismatch,
  workerPortVersionOk,
} from "./protocol.js"

/** A stale-build message was seen; every context that can show it, should. */
export class PortProtocolMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PortProtocolMismatchError"
  }
}

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
   * clients and waits for a donation. Rejects pending waits with
   * {@link PortProtocolMismatchError} when a stale-build donation is seen
   * (consumers retry, so a fresh tab donating later still heals); note
   * that with zero attached clients it simply waits — a repo SharedWorker
   * with no tabs has no one to ask.
   */
  source: () => Promise<WorkerPortLike>

  /** Hand-deliver a port (skips the message protocol). */
  offer(port: WorkerPortLike): void

  /**
   * Evict a (suspected-dead) port from the cache and, when anything is
   * waiting, broadcast a fresh `port-request`. Cache invalidation
   * normally rides on the port's `close` event, but that event can be
   * missed — it is not delivered retroactively to listeners attached
   * after the far side died (a crash racing the donation), and browsers
   * below the documented floor (Chrome <132) never fire it. Consumers
   * hitting repeated connect/init timeouts against a provider-obtained
   * port should invalidate it so the next fetch gets a fresh donation.
   * A no-op unless `port` is (or is omitted and there is) a current port.
   */
  invalidate(port?: WorkerPortLike): void

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
  let waiters: Array<{
    resolve: (port: WorkerPortLike) => void
    reject: (error: Error) => void
  }> = []
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

  /** Removes the current port's close listener; null when none cached. */
  let unwatchCurrent: (() => void) | null = null

  const dropCurrent = () => {
    unwatchCurrent?.()
    unwatchCurrent = null
    current = null
  }

  const offer = (port: WorkerPortLike) => {
    // A superseded `current` (e.g. the benign double donation when an
    // eager donor races a port-request) is left open, not closed:
    // consumers may have cached it, and both ends of a duplicate donation
    // converge on the same io worker anyway. It is dropped on `close`.
    unwatchCurrent?.()
    current = port
    const onClose = () => {
      if (current === port) dropCurrent()
      else port.removeEventListener("close", onClose)
    }
    unwatchCurrent = () => port.removeEventListener("close", onClose)
    port.addEventListener("close", onClose)
    port.start?.()
    const settled = waiters
    waiters = []
    for (const { resolve } of settled) resolve(port)
  }

  return {
    offer,

    invalidate(port?: WorkerPortLike) {
      if (!current || (port !== undefined && port !== current)) return
      dropCurrent()
      if (waiters.length > 0) requestDonation()
    },

    source: () =>
      current
        ? Promise.resolve(current)
        : new Promise<WorkerPortLike>((resolve, reject) => {
            waiters.push({ resolve, reject })
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
          // proxy build would misbehave in far harder-to-debug ways. This
          // provider usually lives in a SharedWorker whose console is
          // invisible (`chrome://inspect` only), so being quiet here would
          // degrade to "storage/sync silently never comes up":
          const description = workerPortVersionMismatch(msg)
          if (!complained) {
            complained = true
            // 1. The worker's own console, for completeness.
            console.error(description)
            // 2. The offending tab, on the error-relay channel it already
            //    knows how to listen to (`isWorkerErrorMessage`).
            try {
              client.postMessage({
                channel: WORKER_ERROR_CHANNEL,
                v: WORKER_PORT_PROTOCOL_VERSION,
                kind: "error",
                message: description,
              })
            } catch {
              // Port already dead; nothing to tell.
            }
          }
          // 3. Anyone awaiting source(): reject rather than hang forever.
          //    Consumers sit in reconnect/retry loops, so a fresh tab
          //    donating later still heals — but the failure is visible.
          const settled = waiters
          waiters = []
          for (const { reject } of settled)
            reject(new PortProtocolMismatchError(description))
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
 * and must mint a *fresh* port each time (a transferred port is detached)
 * — typically `new SharedWorker(ioUrl, ...).port`, which converges on the
 * same io worker instance across tabs while it lives, and respawns it
 * after a crash. It may be async (e.g. awaiting a feature check before
 * choosing the worker URL). Returns a detach function.
 */
export function donatePort(
  client: WorkerPortLike,
  createPort: () => WorkerPortLike | Promise<WorkerPortLike>,
  { target = DEFAULT_TARGET, eager = true }: DonatePortOptions = {}
): () => void {
  const donate = async () => {
    try {
      const port = await createPort()
      client.postMessage(
        {
          channel: PORT_PROVISION_CHANNEL,
          v: WORKER_PORT_PROTOCOL_VERSION,
          type: "port-offer",
          target,
          port,
        },
        [port as unknown as Transferable]
      )
    } catch (error) {
      // e.g. `new SharedWorker(...)` failing; keep it visible — this runs
      // in a tab, where the console is actually readable.
      console.error("[donatePort] donation failed:", error)
    }
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
    if (msg.type === "port-request" && msg.target === target) void donate()
  }

  client.addEventListener("message", onMessage)
  client.start?.()
  if (eager) void donate()

  return () => client.removeEventListener("message", onMessage)
}
