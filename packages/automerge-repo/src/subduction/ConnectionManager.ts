/**
 * Common interface for anything that manages subduction transport connections.
 *
 * SubductionSource holds a list of ConnectionManagers and queries them
 * uniformly — it doesn't need to know whether the underlying transport
 * is a raw WebSocket or a NetworkAdapter tunnel.
 */
export interface ConnectionManager {
  /**
   * Returns true if this manager has connections that are still being
   * established (e.g. WebSocket connecting, adapter handshake in flight).
   * Used by the recompute loop to avoid marking documents as unavailable
   * while connections are still pending.
   */
  isConnecting(): boolean

  /**
   * A monotonically increasing counter that is bumped on every connection
   * state change (peer connected, peer disconnected, adapter readiness
   * changed, etc.). The recompute loop snapshots this when starting a
   * sync and compares on the next recompute to detect whether anything
   * has changed since the last attempt.
   */
  generation(): number

  /**
   * Register a callback that fires on any state change. The caller should
   * use this to schedule a recompute.
   */
  onChange(callback: () => void): void

  /**
   * Stop managing connections. Breaks reconnect loops and prevents new
   * transports from being established.
   */
  shutdown(): void
}
