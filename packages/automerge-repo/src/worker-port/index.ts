/**
 * Worker-port plumbing shared by worker entry files and their clients:
 * error relaying and port provisioning. Dependency-free — importing this
 * subpath does not pull in the `Repo` or any wasm.
 */
export { createErrorRelay, type ErrorRelay } from "./error-relay.js"
export {
  startDriftProbe,
  type DriftProbeOptions,
} from "./drift-probe.js"
export {
  donatePort,
  makePortProvider,
  type DonatePortOptions,
  type PortProvider,
  type PortProviderOptions,
} from "./provide.js"
export {
  PORT_PROVISION_CHANNEL,
  WORKER_ERROR_CHANNEL,
  WORKER_PORT_PROTOCOL_VERSION,
  WORKER_STATS_CHANNEL,
  isPortProvisionMessage,
  isWorkerErrorMessage,
  isWorkerStatsMessage,
  workerPortVersionMismatch,
  workerPortVersionOk,
  type PortProvisionMessage,
  type WorkerErrorMessage,
  type WorkerStatsMessage,
} from "./protocol.js"
