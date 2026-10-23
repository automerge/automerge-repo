import type * as N from "@automerge/subduction/slim"

/** Authenticate an outgoing transport with the backend's signer and register
 * it; resolves to the remote peer ID. Subduction then drives all traffic over
 * the transport until it disconnects. */
export type SubductionConnect = (
  transport: N.Transport,
  audience: N.TransportAudience
) => Promise<string>

/** Supplies transports to a Subduction backend, which owns its lifecycle.
 *
 * @remarks
 * The backend calls `start` once at construction and `stop` once on close.
 * Adapters only produce transports; they never handle messages.
 */
export interface SubductionNetworkAdapterInterface {
  /** Start connecting, including any later reconnection. Settles once the
   * first attempt has: resolves when connected, rejects when it failed. Must
   * settle, as the backend waits on it before deciding a document is
   * unavailable. */
  start(connect: SubductionConnect): Promise<void>

  /** Stop retries, cancel attempts and close this adapter's transports;
   * resolves once cleanup is complete. Never calls `connect` afterwards. */
  stop(): Promise<void>
}
