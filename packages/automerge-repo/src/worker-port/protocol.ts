/**
 * Channel-tagged messages for worker-port plumbing that isn't specific to
 * one host protocol: error relaying and port provisioning. Deliberately
 * dependency-free so worker entry files importing it stay lean.
 */

/** Discriminator for relayed worker errors on a (possibly shared) port. */
export const WORKER_ERROR_CHANNEL = "am-worker-error"

/**
 * An unhandled error or promise rejection inside a worker, relayed to its
 * clients. SharedWorker runtime errors are otherwise invisible outside
 * `chrome://inspect/#workers` — the spec only reports them "to the
 * developer console" of the worker itself.
 */
export interface WorkerErrorMessage {
  channel: typeof WORKER_ERROR_CHANNEL
  kind: "error" | "unhandledrejection"
  message: string
  /** Script URL, when the error event carries one. */
  source?: string
  line?: number
  /** Stack trace, when recoverable from the error object. */
  stack?: string
}

/** Type guard for {@link WorkerErrorMessage} on a shared port. */
export const isWorkerErrorMessage = (
  data: unknown
): data is WorkerErrorMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { channel?: unknown }).channel === WORKER_ERROR_CHANNEL

/** Discriminator for port-provisioning traffic (tab → repo worker). */
export const PORT_PROVISION_CHANNEL = "am-port-provision"

/**
 * Port-provisioning messages. A tab (the only context Chrome allows to
 * spawn workers) offers a `MessagePort` — carried in the message's
 * transfer list — to the context hosting the `Repo`; the repo side may
 * broadcast a request when it needs a (replacement) port.
 */
export type PortProvisionMessage =
  | {
      channel: typeof PORT_PROVISION_CHANNEL
      type: "port-offer"
      /** Which port this is, when one channel provisions several. */
      target: string
      /**
       * The donated port, embedded in the payload (and listed in the
       * transfer list). Embedding — rather than relying on the browser's
       * `event.ports` — also works with Node `worker_threads` ports,
       * which have no `ports` array on message events.
       */
      port: unknown
    }
  | {
      channel: typeof PORT_PROVISION_CHANNEL
      type: "port-request"
      target: string
    }

/** Type guard for {@link PortProvisionMessage} on a shared port. */
export const isPortProvisionMessage = (
  data: unknown
): data is PortProvisionMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { channel?: unknown }).channel === PORT_PROVISION_CHANNEL
