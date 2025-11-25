import { useCallback, useEffect, useRef, useState, useMemo } from "react"

import {
  DocHandle,
  Presence,
  PeerPresenceView,
  PresenceOpts,
} from "@automerge/automerge-repo/slim"
import { useInvalidate } from "./helpers/useInvalidate.js"

export type UsePresenceOpts = Omit<PresenceOpts, "skipAutoInit">

export type UsePresenceResult<State, Channel extends keyof State> = {
  peerStates: PeerPresenceView<State>
  localState: State
  update: (channel: Channel, value: State[Channel]) => void
}

/**
 * This hook encapsulates ephemeral state communication for a specific doc
 * handle. It tracks caller-provided local state and broadcasts that state to
 * all peers. It sends periodic heartbeats when there are no state updates.
 *
 * It also tracks ephemeral state broadcast by peers and forces a re-render when
 * the state of a peer changes.
 *
 * It cleans up (stops sending heartbeats and processing ephemeral messages)
 * when it unmounts.
 *
 * It is implemented using {@link Presence}.
 *
 * @param handle - doc handle to use
 * @param userId - our user id (this is unverified; peers can send anything)
 * @param deviceId - our device id (like userId, this is unverified)
 * @param initialState - the full initial state to broadcast to peers (updates do not trigger a re-render of the hook)
 * @param opts - see {@link UsePresenceOpts} (updates do not trigger a re-render of the hook)
 * @returns see {@link UsePresenceResult}
 */
export function usePresence<State, Channel extends keyof State>(
  handle: DocHandle<unknown>,
  userId: string,
  deviceId: string,
  initialState: State,
  opts?: UsePresenceOpts
): UsePresenceResult<State, Channel> {
  const invalidate = useInvalidate()
  // Don't re-render based on changes to these: they are not expected to
  // change but may be passed in as object literals
  const firstOpts = useRef(opts)
  const firstInitialState = useRef(initialState)
  const presence = useMemo(() => {
    return new Presence(handle, userId, deviceId, firstInitialState.current, {
      ...firstOpts.current,
      skipAutoInit: true,
    })
  }, [handle, userId, deviceId, firstInitialState, firstOpts])

  useEffect(() => {
    presence.initialize()
    presence.on("heartbeat", invalidate)
    presence.on("state", invalidate)
    presence.on("goodbye", invalidate)

    return () => {
      presence.dispose()
    }
  }, [presence])

  const updateLocalState = useCallback(
    (channel: Channel, msg: State[Channel]) => {
      invalidate()
      presence.broadcast(channel, msg)
    },
    [presence]
  )

  return {
    peerStates: presence.getPeerStates(),
    localState: presence.getLocalState(),
    update: updateLocalState,
  }
}
