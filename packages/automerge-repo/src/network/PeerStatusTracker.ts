import { decode } from "cbor-x"
import { EventEmitter } from "eventemitter3"
import { DocumentId, PeerId } from "../types.js"
import { ConnectionEvent, ConnectionStatus } from "../SyncStatus.js"
import type { NetworkAdapterInterface } from "./NetworkAdapterInterface.js"
import type { RepoMessage } from "./messages.js"

const MAX_EVENTS_PER_PEER = 500

export interface PeerStatusTrackerEvents {
  "peer-status-change": (payload: {
    peerId: PeerId
    status: ConnectionStatus
  }) => void
}

/**
 * Tracks connection status and event history for each peer.
 * Designed to observe a NetworkSubsystem without modifying its core logic.
 */
export class PeerStatusTracker extends EventEmitter<PeerStatusTrackerEvents> {
  #statuses: Record<PeerId, ConnectionStatus> = {}

  #ensure(
    peerId: PeerId,
    adapter: NetworkAdapterInterface
  ): ConnectionStatus {
    if (!this.#statuses[peerId]) {
      this.#statuses[peerId] = {
        peerId,
        adapter,
        state: "connecting",
        events: [],
      }
    }
    return this.#statuses[peerId]
  }

  #append(peerId: PeerId, event: ConnectionEvent) {
    const status = this.#statuses[peerId]
    if (!status) return
    status.events.push(event)
    if (status.events.length > MAX_EVENTS_PER_PEER) {
      status.events = status.events.slice(-MAX_EVENTS_PER_PEER)
    }
    this.emit("peer-status-change", { peerId, status })
  }

  #tryDecodeCbor(data: Uint8Array): any {
    try {
      return decode(new Uint8Array(data))
    } catch {
      return data
    }
  }

  peerConnected(peerId: PeerId, adapter: NetworkAdapterInterface) {
    const status = this.#ensure(peerId, adapter)
    status.state = "connected"
    status.adapter = adapter
    this.#append(peerId, { type: "connected", timestamp: new Date() })
  }

  peerDisconnected(peerId: PeerId) {
    if (this.#statuses[peerId]) {
      this.#statuses[peerId].state = "disconnected"
      this.#append(peerId, { type: "disconnected", timestamp: new Date() })
    }
  }

  messageSent(
    targetId: PeerId,
    message: { data?: Uint8Array; type: string; documentId?: DocumentId }
  ) {
    if (this.#statuses[targetId]) {
      const messageData = message.data
        ? this.#tryDecodeCbor(message.data)
        : { type: message.type }
      this.#append(targetId, {
        type: "message_sent",
        timestamp: new Date(),
        ...(message.documentId && { documentId: message.documentId }),
        message: messageData,
      })
    }
  }

  messageReceived(msg: RepoMessage) {
    if (this.#statuses[msg.senderId]) {
      const messageData =
        "data" in msg
          ? this.#tryDecodeCbor(msg.data as Uint8Array)
          : { type: (msg as RepoMessage).type }
      const documentId =
        "documentId" in msg ? (msg as { documentId: DocumentId }).documentId : undefined
      this.#append(msg.senderId, {
        type: "message_received",
        from: msg.senderId,
        timestamp: new Date(),
        ...(documentId && { documentId }),
        message: messageData,
      })
    }
  }

  peerStatuses(): Record<PeerId, ConnectionStatus> {
    return { ...this.#statuses }
  }
}
