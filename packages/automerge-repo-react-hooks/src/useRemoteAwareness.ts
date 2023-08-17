import { useRepo } from "./useRepo"
import { DocHandle } from "@automerge/automerge-repo"
import { useEffect } from "react"
import useStateRef from "react-usestateref"
import EventEmitter from "eventemitter3"

// Emits new_peer event when a new peer is seen
export const peerEvents = new EventEmitter()

/**
 *
 * This hook returns read-only state for remote clients.
 * It also returns their heartbeat status.
 * It is intended to be used alongside useLocalAwareness.
 *
 * @param {string} props.handle A document handle to associate with
 * @param {string?} props.localUserId Automerge BroadcastChannel sometimes sends us our own messages; optionally filters them
 * @param {number?30000} props.offlineTimeout How long to wait (in ms) before marking a peer as offline
 * @param {function?} props.getTime Function to provide current epoch time (used for testing)
 * @returns [ peerStates: { [userId]: state, ... }, { [userId]: heartbeatEpochTime, ...} ]
 */
export interface UseRemoteAwarenessProps {
  handle: DocHandle<unknown>
  localUserId?: string
  offlineTimeout?: number
  getTime?: () => number
}

export type PeerStates = Record<string, any>
export type Heartbeats = Record<string, number>

export const useRemoteAwareness = ({
  handle,
  localUserId,
  offlineTimeout = 30000,
  getTime = () => new Date().getTime(),
}: UseRemoteAwarenessProps): [PeerStates, Heartbeats] => {
  // TODO: You should be able to use multiple instances of this hook on the same handle (write test)
  // TODO: This should support some kind of caching or memoization when switching between channelIDs
  const [peerStates, setPeerStates, peerStatesRef] = useStateRef({})
  const [heartbeats, setHeartbeats, heartbeatsRef] = useStateRef({})
  useEffect(() => {
    // Receive incoming message
    const handleIncomingUpdate = event => {
      try {
        const [userId, state] = event.data
        if (userId === localUserId) return
        if (!heartbeatsRef.current[userId]) peerEvents.emit("new_peer", event) // Let useLocalAwareness know we've seen a new peer
        setPeerStates({
          ...peerStatesRef.current,
          [userId]: state,
        })
        setHeartbeats({
          ...heartbeatsRef.current,
          [userId]: getTime(),
        })
      } catch (e) {
        return
      }
    }
    // Remove peers we haven't seen recently
    const pruneOfflinePeers = () => {
      const peerStates = peerStatesRef.current
      const heartbeats = heartbeatsRef.current
      const time = getTime()
      for (const key in heartbeats) {
        if (time - heartbeats[key] > offlineTimeout) {
          delete peerStates[key]
          delete heartbeats[key]
        }
      }
      setPeerStates(peerStates)
      setHeartbeats(heartbeats)
    }
    handle.on("ephemeral-message", handleIncomingUpdate)
    // Check for offline peers every `offlineTimeout` ms
    const pruneOfflinePeersIntervalId = setInterval(
      pruneOfflinePeers,
      offlineTimeout
    )
    return () => {
      handle.removeListener("ephemeral-message", handleIncomingUpdate)
      clearInterval(pruneOfflinePeersIntervalId)
    }
  }, [handle, localUserId, offlineTimeout, getTime])

  return [peerStates, heartbeats]
}
