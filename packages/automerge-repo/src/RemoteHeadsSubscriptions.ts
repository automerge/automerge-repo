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
type RemoteHeadsSubscriptionEventPayload = {
  documentId: DocumentId
  storageId: StorageId
  remoteHeads: A.Heads
  timestamp: number
}

// Send a message to the given peer notifying them of new heads
type NotifyRemoteHeadsPayload = {
  targetId: PeerId
  documentId: DocumentId
  storageId: StorageId
  heads: A.Heads
  timestamp: number
}

type RemoteHeadsSubscriptionEvents = {
  "remote-heads-changed": (payload: RemoteHeadsSubscriptionEventPayload) => void
  "add-remotes": (payload: { remotes: StorageId[]; peers: PeerId[] }) => void
  "remove-remotes": (payload: { remotes: StorageId[] }) => void
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
    const newRemotes = []
    for (const remote of remotes) {
      if (!this.#ourSubscriptions.has(remote)) {
        this.#ourSubscriptions.add(remote)
        newRemotes.push(remote)
      }
    }
    this.emit("add-remotes", {
      remotes: newRemotes,
      peers: Array.from(this.#generousPeers),
    })
  }

  handleControlMessage(control: RemoteSubscriptionControlMessage) {
    this.#log("handleControlMessage", control)
    if (control.add) {
      for (const remote of control.add) {
        let theirSubs = this.#theirSubscriptions.get(remote)
        if (!theirSubs) {
          theirSubs = new Set()
          this.#theirSubscriptions.set(remote, theirSubs)
        }
        theirSubs.add(control.senderId)
      }
      this.emit("add-remotes", {
        remotes: control.add,
        peers: Array.from(this.#generousPeers),
      })
    }
    if (control.remove) {
      for (const remote of control.remove) {
        const theirSubs = this.#theirSubscriptions.get(remote)
        if (theirSubs) {
          theirSubs.delete(control.senderId)
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

  addGenerousPeer = (peerId: PeerId) => {
    this.#log("addGenerousPeer", peerId)
    this.#generousPeers.add(peerId)

    this.emit("add-remotes", {
      remotes: Array.from(this.#ourSubscriptions),
      peers: [peerId],
    })

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
