/**
 * Bridge that allows Subduction to use automerge-repo network adapters.
 *
 * @example
 * ```ts
 * import { WebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
 * import { Subduction } from "subduction_wasm"
 * import { SubductionNetworkBridge } from "@automerge/automerge-repo-subduction-bridge"
 *
 * const adapter = new WebSocketClientAdapter("ws://localhost:8080")
 * const bridge = new SubductionNetworkBridge(adapter)
 *
 * // Connect the adapter first (this establishes the WebSocket)
 * adapter.connect(repoPeerId)
 * await adapter.whenReady()
 *
 * // Then create a Subduction connection
 * const conn = await bridge.connect(subductionPeerId, 5000)
 * await subduction.attach(conn)
 * ```
 */

import type { NetworkAdapterInterface } from "@automerge/automerge-repo"
import { SubductionWebSocket, PeerId } from "@automerge/automerge_subduction"

/**
 * A network adapter that exposes a WebSocket for Subduction to use.
 */
export interface WebSocketNetworkAdapter extends NetworkAdapterInterface {
    getWebSocket(): WebSocket | undefined
}

/**
 * Bridge that allows Subduction to use automerge-repo network adapters.
 *
 * This extracts the underlying WebSocket from a network adapter and wraps it
 * for use with Subduction's protocol. The adapter handles connection lifecycle
 * (connect, reconnect, disconnect) while Subduction handles the protocol.
 */
export class SubductionNetworkBridge {
    private adapter: WebSocketNetworkAdapter

    constructor(adapter: WebSocketNetworkAdapter) {
        if (!adapter.getWebSocket) {
            throw new Error(
                "Network adapter must implement getWebSocket() to be used with SubductionNetworkBridge"
            )
        }
        this.adapter = adapter
    }

    /**
     * Get the underlying network adapter.
     */
    getAdapter(): WebSocketNetworkAdapter {
        return this.adapter
    }

    /**
     * Create a SubductionWebSocket connection using the adapter's WebSocket.
     *
     * The adapter must already be connected and have an open WebSocket.
     *
     * @param peerId - The Subduction PeerId for this connection
     * @param timeoutMs - Connection timeout in milliseconds
     * @returns A SubductionWebSocket ready to be attached to a Subduction instance
     * @throws Error if the adapter doesn't have a WebSocket available
     */
    async connect(peerId: PeerId, timeoutMs: number): Promise<SubductionWebSocket> {
        const ws = this.adapter.getWebSocket()
        if (!ws) {
            throw new Error(
                "WebSocket not available. Make sure the adapter is connected first."
            )
        }

        return SubductionWebSocket.setup(peerId, ws, timeoutMs)
    }

    /**
     * Wait for the adapter to be ready and then create a SubductionWebSocket connection.
     *
     * This is a convenience method that waits for the adapter's WebSocket to be
     * available before creating the Subduction connection.
     *
     * @param peerId - The Subduction PeerId for this connection
     * @param timeoutMs - Connection timeout in milliseconds
     * @returns A SubductionWebSocket ready to be attached to a Subduction instance
     */
    async connectWhenReady(
        peerId: PeerId,
        timeoutMs: number
    ): Promise<SubductionWebSocket> {
        await this.adapter.whenReady()

        const ws = await this.waitForWebSocket(timeoutMs)

        return SubductionWebSocket.setup(peerId, ws, timeoutMs)
    }

    /**
     * Wait for the WebSocket to become available and open.
     */
    private waitForWebSocket(timeoutMs: number): Promise<WebSocket> {
        return new Promise((resolve, reject) => {
            const startTime = Date.now()

            const check = () => {
                const ws = this.adapter.getWebSocket()
                if (ws && ws.readyState === WebSocket.OPEN) {
                    resolve(ws)
                    return
                }

                if (Date.now() - startTime > timeoutMs) {
                    reject(
                        new Error("Timeout waiting for WebSocket to be available")
                    )
                    return
                }

                setTimeout(check, 50)
            }

            check()
        })
    }
}
