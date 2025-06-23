import { EventEmitter } from "eventemitter3"
import { DocumentId, PeerId, UrlHeads } from "./types.js"
import {
  RemoteHeadsChanged,
  RemoteSubscriptionControlMessage,
} from "./network/messages.js"
import { StorageId } from "./index.js"
import debug from "debug"
import { SyncInfo } from "./DocHandle.js"

// Notify a DocHandle that remote heads have changed
export type RemoteHeadsSubscriptionEventPayload = {
  documentId: DocumentId
  storageId: StorageId
  remoteHeads: UrlHeads
  timestamp: number
}

// Send a message to the given peer notifying them of new heads
export type NotifyRemoteHeadsPayload = {
  targetId: PeerId
  documentId: DocumentId
  storageId: StorageId
  heads: UrlHeads
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
  // Last known heads and timestamp for each storageId that we know about
  #syncInfoByDocId: Map<DocumentId, Map<StorageId, SyncInfo>> = new Map()
  // Storage IDs we have subscribed to via Repo.subscribeToRemoteHeads
  #ourSubscriptions: Set<StorageId> = new Set()
  // Storage IDs other peers have subscribed to by sending us a control message
  #theirSubscriptions: Map<StorageId, Set<PeerId>> = new Map()
  // Peers we will always share remote heads with even if they are not subscribed
  #generousPeers: Set<PeerId> = new Set()
  // Documents each peer has open, we need this information so we only send remote heads of documents that the peer knows
  #subscribedDocsByPeer: Map<PeerId, Set<DocumentId>> = new Map()

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
    const addedRemotesWeKnow: StorageId[] = []

    this.#log("handleControlMessage", control)
    if (control.add) {
      for (const remote of control.add) {
        let theirSubs = this.#theirSubscriptions.get(remote)

        if (this.#ourSubscriptions.has(remote) || theirSubs) {
          addedRemotesWeKnow.push(remote)
        }

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

    // send all our stored heads of documents the peer knows for the remotes they've added
    for (const remote of addedRemotesWeKnow) {
      const subscribedDocs = this.#subscribedDocsByPeer.get(control.senderId)
      if (subscribedDocs) {
        for (const documentId of subscribedDocs) {
          const syncInfo = this.#syncInfoByDocId.get(documentId)
          if (!syncInfo) {
            continue
          }

          const syncInfoForRemote = syncInfo.get(remote)
          if (syncInfoForRemote) {
            this.emit("notify-remote-heads", {
              targetId: control.senderId,
              documentId,
              heads: syncInfoForRemote.lastHeads,
              timestamp: syncInfoForRemote.lastSyncTimestamp,
              storageId: remote,
            })
          }
        }
      }
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
          if (this.#isPeerSubscribedToDoc(peerId, event.documentId)) {
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
  }

  /** A peer we are directly connected to has updated their heads */
  handleImmediateRemoteHeadsChanged(
    documentId: DocumentId,
    storageId: StorageId,
    heads: UrlHeads
  ) {
    this.#log("handleLocalHeadsChanged", documentId, storageId, heads)
    const remote = this.#syncInfoByDocId.get(documentId)
    const timestamp = Date.now()
    if (!remote) {
      this.#syncInfoByDocId.set(
        documentId,
        new Map([
          [storageId, { lastSyncTimestamp: timestamp, lastHeads: heads }],
        ])
      )
    } else {
      const docRemote = remote.get(storageId)
      if (!docRemote || docRemote.lastSyncTimestamp < Date.now()) {
        remote.set(storageId, {
          lastSyncTimestamp: Date.now(),
          lastHeads: heads,
        })
      }
    }
    const theirSubs = this.#theirSubscriptions.get(storageId)
    if (theirSubs) {
      for (const peerId of theirSubs) {
        if (this.#isPeerSubscribedToDoc(peerId, documentId)) {
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

    for (const [documentId, remote] of this.#syncInfoByDocId) {
      for (const [storageId, { lastHeads, lastSyncTimestamp }] of remote) {
        this.emit("notify-remote-heads", {
          targetId: peerId,
          documentId: documentId,
          heads: lastHeads,
          timestamp: lastSyncTimestamp,
          storageId: storageId,
        })
      }
    }
  }

  removePeer(peerId: PeerId) {
    this.#log("removePeer", peerId)

    const remotesToRemove = []

    this.#generousPeers.delete(peerId)
    this.#subscribedDocsByPeer.delete(peerId)

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

  subscribePeerToDoc(peerId: PeerId, documentId: DocumentId) {
    let subscribedDocs = this.#subscribedDocsByPeer.get(peerId)
    if (!subscribedDocs) {
      subscribedDocs = new Set()
      this.#subscribedDocsByPeer.set(peerId, subscribedDocs)
    }

    subscribedDocs.add(documentId)

    const remoteHeads = this.#syncInfoByDocId.get(documentId)
    if (remoteHeads) {
      for (const [storageId, lastHeads] of remoteHeads) {
        const subscribedPeers = this.#theirSubscriptions.get(storageId)
        if (subscribedPeers && subscribedPeers.has(peerId)) {
          this.emit("notify-remote-heads", {
            targetId: peerId,
            documentId,
            heads: lastHeads.lastHeads,
            timestamp: lastHeads.lastSyncTimestamp,
            storageId,
          })
        }
      }
    }
  }

  #isPeerSubscribedToDoc(peerId: PeerId, documentId: DocumentId) {
    const subscribedDocs = this.#subscribedDocsByPeer.get(peerId)
    return subscribedDocs && subscribedDocs.has(documentId)
  }

  /** Returns the (document, storageId) pairs which have changed after processing msg */
  #changedHeads(msg: RemoteHeadsChanged): {
    documentId: DocumentId
    storageId: StorageId
    remoteHeads: UrlHeads
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
      let remote = this.#syncInfoByDocId.get(documentId)
      if (!remote) {
        remote = new Map()
        this.#syncInfoByDocId.set(documentId, remote)
      }

      const docRemote = remote.get(storageId as StorageId)
      if (docRemote && docRemote.lastSyncTimestamp >= timestamp) {
        continue
      } else {
        remote.set(storageId as StorageId, {
          lastSyncTimestamp: timestamp,
          lastHeads: heads as UrlHeads,
        })
        changedHeads.push({
          documentId,
          storageId: storageId as StorageId,
          remoteHeads: heads as UrlHeads,
          timestamp,
        })
      }
    }
    return changedHeads
  }
}
