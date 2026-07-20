/**
 * Channel-tagged messages for worker-port plumbing that isn't specific to
 * one host protocol: error relaying and port provisioning. Deliberately
 * dependency-free so worker entry files importing it stay lean.
 */

/**
 * Wire-protocol version for all worker-port channels in this module,
 * stamped on every message by the sender and verified by receivers.
 *
 * Proxy/repo workers are often separately emitted, separately cached
 * chunks, so a stale worker can end up speaking to a freshly-deployed
 * page (or vice versa). Receivers treat a mismatch — including a missing
 * tag from a pre-versioning build — as an error and report it loudly
 * rather than silently misparsing traffic. Bump on any incompatible
 * change.
 */
export const WORKER_PORT_PROTOCOL_VERSION = 1

/** Does an already-channel-matched message carry the version we speak? */
export const workerPortVersionOk = (data: unknown): boolean =>
  (data as { v?: unknown }).v === WORKER_PORT_PROTOCOL_VERSION

/** Human-readable description of a version mismatch, for error surfaces. */
export const workerPortVersionMismatch = (data: unknown): string => {
  const got = (data as { v?: number }).v
  const channel = (data as { channel?: unknown }).channel
  return (
    `worker-port protocol version mismatch on channel "${String(channel)}": ` +
    `expected v${WORKER_PORT_PROTOCOL_VERSION}, got ` +
    `${got === undefined ? "an untagged (pre-versioning) message" : `v${String(got)}`}. ` +
    "The two contexts are running different builds — likely a stale cached " +
    "worker chunk after a deploy. Reload / clear the worker cache so both " +
    "sides come from the same release."
  )
}

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
  /** Protocol version ({@link WORKER_PORT_PROTOCOL_VERSION}). */
  v: number
  kind: "error" | "unhandledrejection"
  message: string
  /** Script URL, when the error event carries one. */
  source?: string
  line?: number
  /** Stack trace, when recoverable from the error object. */
  stack?: string
}

/**
 * Type guard for {@link WorkerErrorMessage} on a shared port. Also
 * requires the protocol version to match — a skewed build's messages may
 * not have the shape the type promises. Use
 * {@link workerPortVersionOk} / {@link workerPortVersionMismatch} to
 * detect-and-report skew separately if needed.
 */
export const isWorkerErrorMessage = (
  data: unknown
): data is WorkerErrorMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { channel?: unknown }).channel === WORKER_ERROR_CHANNEL &&
  workerPortVersionOk(data)

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
      /** Protocol version ({@link WORKER_PORT_PROTOCOL_VERSION}). */
      v: number
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
      /** Protocol version ({@link WORKER_PORT_PROTOCOL_VERSION}). */
      v: number
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

/** Discriminator for worker health/timing stats on a (possibly shared) port. */
export const WORKER_STATS_CHANNEL = "am-worker-stats"

/**
 * A timing sample from a worker's drift probe (see `startDriftProbe`):
 * how late a periodic timer fired, i.e. how long the worker's event loop
 * was blocked by long tasks. Emitted only when the drift crosses the
 * probe's report threshold; a healthy worker reports nothing.
 */
export interface WorkerStatsMessage {
  channel: typeof WORKER_STATS_CHANNEL
  /** Protocol version ({@link WORKER_PORT_PROTOCOL_VERSION}). */
  v: number
  kind: "drift"
  /** How late the timer fired beyond its interval, in ms. */
  driftMs: number
  /** The probe's nominal interval, for interpreting `driftMs`. */
  intervalMs: number
  /** Sample time (epoch ms) on the worker's clock. */
  at: number
}

/**
 * Type guard for {@link WorkerStatsMessage} on a shared port. Also
 * requires the protocol version to match (see
 * {@link isWorkerErrorMessage}).
 */
export const isWorkerStatsMessage = (
  data: unknown
): data is WorkerStatsMessage =>
  typeof data === "object" &&
  data !== null &&
  (data as { channel?: unknown }).channel === WORKER_STATS_CHANNEL &&
  workerPortVersionOk(data)
