import { next as A } from "@automerge/automerge"
import { EventEmitter } from "eventemitter3"
import { DocumentId, PeerId } from "./types.js"
import {
  RemoteHeadsChanged,
  RemoteSubscriptionControlMessage,
} from "./network/messages.js"
import { StorageId } from "./index.js"
import debug from "debug"

// Notify a DocHandle that remote heads have changed
export type RemoteHeadsSubscriptionEventPayload = {
  documentId: DocumentId
  storageId: StorageId
  remoteHeads: A.Heads
  timestamp: number
}

// Send a message to the given peer notifying them of new heads
export type NotifyRemoteHeadsPayload = {
  targetId: PeerId
  documentId: DocumentId
  storageId: StorageId
  heads: A.Heads
  timestamp: number
}

type RemoteHeadsSubscriptionEvents = {
  "remote-heads-changed": (payload: RemoteHeadsSubscriptionEventPayload) => void
  "change-remote-subs": (payload: {
    peers: PeerId[]
    add?: StorageId[]
    remove?: StorageId[]
  }) => void
  "notify-remote-heads": (payload: NotifyRemoteHeadsPayload) => void
}

export class RemoteHeadsSubscriptions extends EventEmitter<RemoteHeadsSubscriptionEvents> {
  // Storage IDs we have received remote heads from
  #knownHeads: Map<DocumentId, Map<StorageId, LastHeads>> = new Map()
  // Storage IDs we have subscribed to via Repo.subscribeToRemoteHeads
  #ourSubscriptions: Set<StorageId> = new Set()
  // Storage IDs other peers have subscribed to by sending us a control message
  #theirSubscriptions: Map<StorageId, Set<PeerId>> = new Map()
  // Peers we will always share remote heads with even if they are not subscribed
  #generousPeers: Set<PeerId> = new Set()
  #log = debug("automerge-repo:remote-heads-subscriptions")

  subscribeToRemotes(remotes: StorageId[]) {
    this.#log("subscribeToRemotes", remotes)
    const remotesToAdd = []
    for (const remote of remotes) {
      if (!this.#ourSubscriptions.has(remote)) {
        this.#ourSubscriptions.add(remote)
        remotesToAdd.push(remote)
      }
    }

    if (remotesToAdd.length > 0) {
      this.emit("change-remote-subs", {
        add: remotesToAdd,
        peers: Array.from(this.#generousPeers),
      })
    }
  }

  unsubscribeFromRemotes(remotes: StorageId[]) {
    this.#log("subscribeToRemotes", remotes)
    const remotesToRemove = []

    for (const remote of remotes) {
      if (this.#ourSubscriptions.has(remote)) {
        this.#ourSubscriptions.delete(remote)

        if (!this.#theirSubscriptions.has(remote)) {
          remotesToRemove.push(remote)
        }
      }
    }

    if (remotesToRemove.length > 0) {
      this.emit("change-remote-subs", {
        remove: remotesToRemove,
        peers: Array.from(this.#generousPeers),
      })
    }
  }

  handleControlMessage(control: RemoteSubscriptionControlMessage) {
    const remotesToAdd: StorageId[] = []
    const remotesToRemove: StorageId[] = []

    this.#log("handleControlMessage", control)
    if (control.add) {
      for (const remote of control.add) {
        let theirSubs = this.#theirSubscriptions.get(remote)
        if (!theirSubs) {
          theirSubs = new Set()
          this.#theirSubscriptions.set(remote, theirSubs)

          if (!this.#ourSubscriptions.has(remote)) {
            remotesToAdd.push(remote)
          }
        }

        theirSubs.add(control.senderId)
      }
    }

    if (control.remove) {
      for (const remote of control.remove) {
        const theirSubs = this.#theirSubscriptions.get(remote)
        if (theirSubs) {
          theirSubs.delete(control.senderId)

          // if no one is subscribed anymore remove remote
          if (theirSubs.size == 0 && !this.#ourSubscriptions.has(remote)) {
            remotesToRemove.push(remote)
          }
        }
      }
    }

    if (remotesToAdd.length > 0 || remotesToRemove.length > 0) {
      this.emit("change-remote-subs", {
        peers: Array.from(this.#generousPeers),
        add: remotesToAdd,
        remove: remotesToRemove,
      })
    }
  }

  /** A peer we are not directly connected to has changed their heads */
  handleRemoteHeads(msg: RemoteHeadsChanged) {
    this.#log("handleRemoteHeads", msg)
    const changedHeads = this.#changedHeads(msg)

    // Emit a remote-heads-changed event to update local dochandles
    for (const event of changedHeads) {
      if (this.#ourSubscriptions.has(event.storageId)) {
        this.emit("remote-heads-changed", event)
      }
    }

    // Notify generous peers of these changes regardless of if they are subscribed to us
    for (const event of changedHeads) {
      for (const peer of this.#generousPeers) {
        // don't emit event to sender if sender is a generous peer
        if (peer === msg.senderId) {
          continue
        }

        this.emit("notify-remote-heads", {
          targetId: peer,
          documentId: event.documentId,
          heads: event.remoteHeads,
          timestamp: event.timestamp,
          storageId: event.storageId,
        })
      }
    }

    // Notify subscribers of these changes
    for (const event of changedHeads) {
      const theirSubs = this.#theirSubscriptions.get(event.storageId)
      if (theirSubs) {
        for (const peerId of theirSubs) {
          this.emit("notify-remote-heads", {
            targetId: peerId,
            documentId: event.documentId,
            heads: event.remoteHeads,
            timestamp: event.timestamp,
            storageId: event.storageId,
          })
        }
      }
    }
  }

  /** A peer we are directly connected to has updated their heads */
  handleImmediateRemoteHeadsChanged(
    documentId: DocumentId,
    storageId: StorageId,
    heads: A.Heads
  ) {
    this.#log("handleLocalHeadsChanged", documentId, storageId, heads)
    const remote = this.#knownHeads.get(documentId)
    const timestamp = Date.now()
    if (!remote) {
      this.#knownHeads.set(
        documentId,
        new Map([[storageId, { heads, timestamp }]])
      )
    } else {
      const docRemote = remote.get(storageId)
      if (!docRemote || docRemote.timestamp < Date.now()) {
        remote.set(storageId, { heads, timestamp: Date.now() })
      }
    }
    const theirSubs = this.#theirSubscriptions.get(storageId)
    if (theirSubs) {
      for (const peerId of theirSubs) {
        this.emit("notify-remote-heads", {
          targetId: peerId,
          documentId: documentId,
          heads: heads,
          timestamp: timestamp,
          storageId: storageId,
        })
      }
    }
  }

  addGenerousPeer(peerId: PeerId) {
    this.#log("addGenerousPeer", peerId)
    this.#generousPeers.add(peerId)

    if (this.#ourSubscriptions.size > 0) {
      this.emit("change-remote-subs", {
        add: Array.from(this.#ourSubscriptions),
        peers: [peerId],
      })
    }

    for (const [documentId, remote] of this.#knownHeads) {
      for (const [storageId, { heads, timestamp }] of remote) {
        this.emit("notify-remote-heads", {
          targetId: peerId,
          documentId: documentId,
          heads: heads,
          timestamp: timestamp,
          storageId: storageId,
        })
      }
    }
  }

  removePeer(peerId: PeerId) {
    this.#log("removePeer", peerId)

    const remotesToRemove = []

    this.#generousPeers.delete(peerId)

    for (const [storageId, peerIds] of this.#theirSubscriptions) {
      if (peerIds.has(peerId)) {
        peerIds.delete(peerId)

        if (peerIds.size == 0) {
          remotesToRemove.push(storageId)
          this.#theirSubscriptions.delete(storageId)
        }
      }
    }

    if (remotesToRemove.length > 0) {
      this.emit("change-remote-subs", {
        remove: remotesToRemove,
        peers: Array.from(this.#generousPeers),
      })
    }
  }

  /** Returns the (document, storageId) pairs which have changed after processing msg */
  #changedHeads(msg: RemoteHeadsChanged): {
    documentId: DocumentId
    storageId: StorageId
    remoteHeads: A.Heads
    timestamp: number
  }[] {
    const changedHeads = []
    const { documentId, newHeads } = msg
    for (const [storageId, { heads, timestamp }] of Object.entries(newHeads)) {
      if (
        !this.#ourSubscriptions.has(storageId as StorageId) &&
        !this.#theirSubscriptions.has(storageId as StorageId)
      ) {
        continue
      }
      let remote = this.#knownHeads.get(documentId)
      if (!remote) {
        remote = new Map([[storageId as StorageId, { heads, timestamp }]])
        this.#knownHeads.set(documentId, remote)
      }

      const docRemote = remote.get(storageId as StorageId)
      if (docRemote && docRemote.timestamp > timestamp) {
        continue
      } else {
        remote.set(storageId as StorageId, { timestamp, heads })
        changedHeads.push({
          documentId,
          storageId: storageId as StorageId,
          remoteHeads: heads,
          timestamp,
        })
      }
    }
    return changedHeads
  }
}

type LastHeads = {
  timestamp: number
  heads: A.Heads
}
