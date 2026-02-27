import { useCallback, useEffect, useRef, useState } from "react"

import {
  Presence,
  PresenceConfig,
  DocHandle,
  UserId,
  DeviceId,
  PeerStateView,
  PresenceState,
} from "@automerge/automerge-repo/slim"

export type UsePresenceConfig<State extends PresenceState> =
  PresenceConfig<State> & {
    handle: DocHandle<unknown>
    userId?: UserId
    deviceId?: DeviceId
  }

export type UsePresenceResult<State extends PresenceState> = {
  peerStates: PeerStateView<State>
  localState: State | undefined
  update: <Channel extends keyof State>(
    channel: Channel,
    value: State[Channel]
  ) => void
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
 * @param config - see {@link UsePresenceConfig}. Note that initialState only
 * determines the initial value. Updates to this param will not trigger a
 * re-render of the hook.
 *
 * @returns see {@link UsePresenceResult}
 */
export function usePresence<State extends PresenceState>({
  handle,
  userId,
  deviceId,
  initialState,
  heartbeatMs,
  peerTtlMs,
}: UsePresenceConfig<State>): UsePresenceResult<State> {
  const [localState, setLocalState] = useState<State>(initialState)
  const [peerStates, setPeerStates] = useState(new PeerStateView<State>({}))
  // Don't re-render based on changes to these: they are not expected to
  // change but may be passed in as object literals
  const firstOpts = useRef({
    heartbeatMs,
    peerTtlMs,
  })
  const firstInitialState = useRef(initialState)
  const [presence] = useState(
    () => new Presence<State>({ handle, userId, deviceId })
  )

  useEffect(() => {
    presence.start({
      initialState: firstInitialState.current,
      ...firstOpts.current,
    })
    presence.on("heartbeat", () => setPeerStates(presence.getPeerStates()))
    presence.on("snapshot", () => setPeerStates(presence.getPeerStates()))
    presence.on("update", () => setPeerStates(presence.getPeerStates()))
    presence.on("goodbye", () => setPeerStates(presence.getPeerStates()))

    return () => {
      presence.stop()
    }
  }, [presence, userId, deviceId, firstInitialState, firstOpts])

  const update = useCallback(
    <Channel extends keyof State>(channel: Channel, msg: State[Channel]) => {
      presence.broadcast(channel, msg)
      const updated = presence.getLocalState()
      setLocalState(updated)
    },
    [presence]
  )

  return {
    peerStates,
    localState,
    update,
  }
}
