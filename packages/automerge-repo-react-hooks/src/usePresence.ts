import { useCallback, useEffect, useState } from "react"

import {
  DocHandle,
  Presence,
  PeerPresenceStates,
  LocalState,
  PresenceOpts,
} from "@automerge/automerge-repo/slim"

export type UsePresenceResult<State, Channel extends keyof State> = {
  peerStates: PeerPresenceStates<State>
  localState: LocalState<State>
  update: (channel: Channel, value: State[Channel]) => void
}

function useInvalidate() {
  const [, setState] = useState(0)
  const increment = useCallback(() => setState(value => value + 1), [setState])
  return increment
}

export function usePresence<State, Channel extends keyof State>(
  handle: DocHandle<unknown>,
  userId: string,
  deviceId: string,
  initialState: State,
  opts?: PresenceOpts
): UsePresenceResult<State, Channel> {
  const invalidate = useInvalidate()
  const [presence] = useState(() => {
    const presence = new Presence(handle, userId, deviceId, initialState, opts)
    presence.on("heartbeat", invalidate)
    presence.on("state", invalidate)
    presence.on("goodbye", invalidate)
    return presence
  })

  useEffect(() => {
    return () => presence.dispose()
  }, [presence])

  const updateLocalState = useCallback(
    (channel: Channel, msg: State[Channel]) => {
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
