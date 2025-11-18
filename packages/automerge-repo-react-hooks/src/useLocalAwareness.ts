import { useEffect } from "react"
import useStateRef from "react-usestateref"
import { peerEvents } from "./useRemoteAwareness.js"
import { DocHandle } from "@automerge/automerge-repo/slim"

export interface UseLocalAwarenessProps {
  /** The document handle to send ephemeral state on */
  handle?: DocHandle<unknown>
  /** Our user ID **/
  userId: string
  /** The initial state object/primitive we should advertise */
  initialState: any
  /** How frequently to send heartbeats */
  heartbeatTime?: number
}
/**
 * This hook maintains state for the local client.
 * Like React.useState, it returns a [state, setState] array.
 * It is intended to be used alongside useRemoteAwareness.
 *
 * When state is changed it is broadcast to all clients.
 * It also broadcasts a heartbeat to let other clients know it is online.
 *
 * Note that userIds aren't secure (yet). Any client can lie about theirs.
 *
 * @param {string} props.userId Unique user ID. Clients can lie about this.
 * @param {any} props.initialState Initial state object/primitive
 * @param {number?1500} props.heartbeatTime How often to send a heartbeat (in ms)
 * @returns [state, setState]
 */
export const useLocalAwareness = ({
  handle,
  userId,
  initialState,
  heartbeatTime = 15000,
}: UseLocalAwarenessProps) => {
  const [localState, setLocalState, localStateRef] = useStateRef(initialState)

  const setState = (stateOrUpdater: any) => {
    const state =
      typeof stateOrUpdater === "function"
        ? stateOrUpdater(localStateRef.current)
        : stateOrUpdater
    setLocalState(state)
    // TODO: Send deltas instead of entire state
    if (handle) {
      handle.broadcast([userId, state])
    }
  }

  useEffect(() => {
    // Don't broadcast if userId or handle isn't set: this avoids bogus broadcasts
    // during the loading of a userId document or handle.
    if (!userId || !handle) {
      return
    }

    // Send periodic heartbeats
    const heartbeat = () =>
      void handle.broadcast([userId, localStateRef.current])
    heartbeat() // Initial heartbeat
    // TODO: we don't need to send a heartbeat if we've changed state recently; use recursive setTimeout instead of setInterval
    const heartbeatIntervalId = setInterval(heartbeat, heartbeatTime)
    return () => void clearInterval(heartbeatIntervalId)
  }, [handle, userId, heartbeatTime])

  useEffect(() => {
    // Send entire state to new peers
    if (!handle || !userId) {
      return
    }

    let broadcastTimeoutId: ReturnType<typeof setTimeout>
    const newPeerEvents = peerEvents.on("new_peer", () => {
      broadcastTimeoutId = setTimeout(
        () => handle?.broadcast([userId, localStateRef.current]),
        500 // Wait for the peer to be ready
      )
    })
    return () => {
      newPeerEvents.off("new_peer")
      broadcastTimeoutId && clearTimeout(broadcastTimeoutId)
    }
  }, [handle, userId, peerEvents])

  // TODO: Send an "offline" message on unmount
  // useEffect(
  //   () => () => void handle.broadcast(null), // Same as Yjs awareness
  //   []
  // );

  return [localState, setState]
}
