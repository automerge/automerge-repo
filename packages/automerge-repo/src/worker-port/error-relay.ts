/**
 * Relay unhandled errors from a worker's global scope to its clients.
 *
 * Runtime errors inside a SharedWorker are invisible to tabs — the spec
 * reports them only to the worker's own console (`chrome://inspect`).
 * Worker entry files call {@link createErrorRelay} once and register each
 * client port; tabs listen for {@link WORKER_ERROR_CHANNEL} messages.
 */

import {
  WORKER_ERROR_CHANNEL,
  type WorkerErrorMessage,
} from "./protocol.js"

/** The subset of a port the relay needs (fan-out only). */
interface ErrorRelayPort {
  postMessage(message: unknown): void
  addEventListener?(type: "close", listener: () => void): void
}

export interface ErrorRelay {
  /** Start relaying to this port; removed automatically when it closes. */
  addPort(port: ErrorRelayPort): void
  /** Remove the global listeners and forget all ports. */
  dispose(): void
}

const describe = (reason: unknown): { message: string; stack?: string } => {
  if (reason instanceof Error)
    return { message: reason.message, stack: reason.stack }
  return { message: String(reason) }
}

/**
 * Install `error` / `unhandledrejection` listeners on `scope` (default:
 * the worker's own global scope) and fan matching events out to every
 * registered port as {@link WorkerErrorMessage}s. A port whose far side
 * has closed is pruned via its `close` event (Chrome ≥132); posting to a
 * closed port is otherwise a silent no-op, so stale entries are harmless.
 */
export function createErrorRelay(
  scope: EventTarget = globalThis as unknown as EventTarget
): ErrorRelay {
  const ports = new Set<ErrorRelayPort>()

  const broadcast = (
    msg: Omit<WorkerErrorMessage, "channel">
  ): void => {
    for (const port of ports) {
      try {
        port.postMessage({ channel: WORKER_ERROR_CHANNEL, ...msg })
      } catch {
        ports.delete(port) // e.g. a detached Node port
      }
    }
  }

  const onError = (event: Event) => {
    const e = event as ErrorEvent
    broadcast({
      kind: "error",
      message: e.message ?? "unknown worker error",
      source: e.filename || undefined,
      line: e.lineno || undefined,
      stack: e.error instanceof Error ? e.error.stack : undefined,
    })
  }

  const onRejection = (event: Event) => {
    const reason = (event as PromiseRejectionEvent).reason
    broadcast({ kind: "unhandledrejection", ...describe(reason) })
  }

  scope.addEventListener("error", onError)
  scope.addEventListener("unhandledrejection", onRejection)

  return {
    addPort(port: ErrorRelayPort) {
      ports.add(port)
      port.addEventListener?.("close", () => ports.delete(port))
    },
    dispose() {
      scope.removeEventListener("error", onError)
      scope.removeEventListener("unhandledrejection", onRejection)
      ports.clear()
    },
  }
}
