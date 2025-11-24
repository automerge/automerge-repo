import { useCallback, useEffect, useRef, useState, useMemo } from "react"

import {
  DocHandle,
  Presence,
  PeerPresenceView,
  LocalState,
  PresenceOpts,
} from "@automerge/automerge-repo/slim"
import { useInvalidate } from "./helpers/useInvalidate.js"

export type UsePresenceResult<State, Channel extends keyof State> = {
  peerStates: PeerPresenceView<State>
  localState: LocalState<State>
  update: (channel: Channel, value: State[Channel]) => void
}

export function usePresence<State, Channel extends keyof State>(
  handle: DocHandle<unknown>,
  userId: string,
  deviceId: string,
  initialState: State,
  opts?: Omit<PresenceOpts, "skipAutoInit">
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
