import { useCallback, useEffect, useRef, useState, useMemo } from "react"

import {
  DocHandle,
  Presence,
  PeerPresenceStates,
  LocalState,
  PresenceOpts,
} from "@automerge/automerge-repo/slim"
import { useInvalidate } from "./helpers/useInvalidate.js"

export type UsePresenceResult<State, Channel extends keyof State> = {
  peerStates: PeerPresenceStates<State>
  localState: LocalState<State>
  update: (channel: Channel, value: State[Channel]) => void
}

export function usePresence<State, Channel extends keyof State>(
  handle: DocHandle<unknown>,
  userId: string,
  deviceId: string,
  initialState: State,
  opts?: PresenceOpts
): UsePresenceResult<State, Channel> {
  const invalidate = useInvalidate();
  // Don't re-render based on changes to these: they are not expected to
  // change but may be passed in as object literals
  const firstOpts = useRef(opts)
  const firstInitialState = useRef(initialState)
  const presence = useRef<Presence<State, Channel>>(undefined)
  // If we have not yet initialized the ref, create a new Presence. The ref will
  // be initialized with useEffect, but that runs *after* the render, so we want
  // to make sure that there's a presence available *during* the first render,
  // so we create it if the ref is undefined. We don't pass it directly as a
  // `useRef` initializer, since that would run the constructor on every render.
  if (!presence.current) {
    presence.current ||= new Presence(handle, userId, deviceId, firstInitialState.current, firstOpts.current)
    console.log("created presence", presence.current!.name)
  }
   

  useEffect(() => {
    if (presence.current!.disposed) {
      const oldName = presence.current!.name
      presence.current = new Presence(handle, userId, deviceId, firstInitialState.current, firstOpts.current)
      console.log("replacing disposed", oldName, "with", presence.current!.name)
    }
    const p = presence.current!

    p.on("heartbeat", invalidate)
    p.on("state", invalidate)
    p.on("goodbye", invalidate)

    return () => {
      console.log("disposing", p.name)
      p.dispose()
    }
  }, [handle, userId, deviceId, firstInitialState, firstOpts, presence])


  const updateLocalState = useCallback(
    (channel: Channel, msg: State[Channel]) => {
      invalidate()
      presence.current!.broadcast(channel, msg)
    },
    [presence]
  )

  return {
    peerStates: presence.current.getPeerStates(),
    localState: presence.current.getLocalState(),
    update: updateLocalState,
  }
}

