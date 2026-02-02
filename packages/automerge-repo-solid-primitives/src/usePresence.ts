import {
  type DeviceId,
  type DocHandle,
  PeerStateView,
  Presence,
  type PresenceConfig,
  type PresenceState,
  type UserId,
} from "@automerge/automerge-repo/slim"
import { type Accessor, createSignal, onCleanup, onMount } from "solid-js"

export type UsePresenceConfig<State extends PresenceState> =
  PresenceConfig<State> & {
    handle: DocHandle<unknown>
    userId?: UserId
    deviceId?: DeviceId
  }

export type UsePresenceResult<State extends PresenceState> = {
  peerStates: Accessor<PeerStateView<State>>
  localState: Accessor<State> | undefined
  update: <Channel extends keyof State>(
    channel: Channel,
    value: State[Channel]
  ) => void
  start: (config?: Partial<PresenceConfig<State>>) => void
  stop: () => void
}

export function usePresence<State extends PresenceState>({
  handle,
  userId,
  deviceId,
  initialState,
  heartbeatMs,
  peerTtlMs,
}: UsePresenceConfig<State>): UsePresenceResult<State> {
  const [localState, setLocalState] = createSignal<State>(initialState)
  const [peerStates, setPeerStates] = createSignal(new PeerStateView<State>({}))
  const [presence] = createSignal(
    new Presence<State>({ handle, userId, deviceId })
  )
  const firstInitialState = initialState
  let currentTiming = { heartbeatMs, peerTtlMs }

  const setupPresenceHandlers = () => {
    const presenceHandle = presence()

    presenceHandle.on("heartbeat", () =>
      setPeerStates(presenceHandle.getPeerStates())
    )
    presenceHandle.on("snapshot", () =>
      setPeerStates(presenceHandle.getPeerStates())
    )
    presenceHandle.on("update", () =>
      setPeerStates(presenceHandle.getPeerStates())
    )
    presenceHandle.on("goodbye", () =>
      setPeerStates(presenceHandle.getPeerStates())
    )
  }

  onMount(() => {
    const presenceHandle = presence()
    presenceHandle.start({
      initialState: firstInitialState,
      ...currentTiming,
    })
    setupPresenceHandlers()
  })

  onCleanup(() => {
    presence().stop()
  })

  const update = <Channel extends keyof State>(
    channel: Channel,
    msg: State[Channel]
  ) => {
    presence().broadcast(channel, msg)
    const updated = presence().getLocalState()
    setLocalState(() => updated)
  }

  const start = (config?: Partial<PresenceConfig<State>>) => {
    const initialState = config?.initialState ?? presence().getLocalState()
    currentTiming = {
      heartbeatMs: config?.heartbeatMs ?? currentTiming.heartbeatMs,
      peerTtlMs: config?.peerTtlMs ?? currentTiming.peerTtlMs,
    }
    presence().start({
      initialState,
      ...currentTiming,
    })
    setupPresenceHandlers()
  }

  const stop = () => {
    presence().stop()
  }

  return {
    localState,
    peerStates,
    update,
    start,
    stop,
  }
}
