import {
  type DeviceId,
  type DocHandle,
  PeerStateView,
  Presence,
  type PresenceConfig,
  type PresenceState,
  type UserId,
} from "@automerge/automerge-repo/slim"
import { onCleanup } from "solid-js"
import { createStore, reconcile, type Store } from "solid-js/store"

export type UsePresenceConfig<State extends PresenceState> =
  PresenceConfig<State> & {
    handle: DocHandle<unknown>
    userId?: UserId
    deviceId?: DeviceId
  }

export type UsePresenceResult<State extends PresenceState> = {
  peerStates: Store<PeerStateView<State>>
  localState: Store<State> | undefined
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
  const [localState, setLocalState] = createStore<State>(initialState)
  const [peerStates, setPeerStates] = createStore(new PeerStateView<State>({}))
  const presence = new Presence<State>({ handle, userId, deviceId })
  const firstInitialState = initialState
  let currentTiming = { heartbeatMs, peerTtlMs }

  const setupPresenceHandlers = () => {
    const presenceHandle = presence

    presenceHandle.on("heartbeat", () =>
      setPeerStates(reconcile(presenceHandle.getPeerStates()))
    )
    presenceHandle.on("snapshot", () =>
      setPeerStates(reconcile(presenceHandle.getPeerStates()))
    )
    presenceHandle.on("update", () =>
      setPeerStates(reconcile(presenceHandle.getPeerStates()))
    )
    presenceHandle.on("goodbye", () =>
      setPeerStates(reconcile(presenceHandle.getPeerStates()))
    )
  }

  presence.start({
    initialState: firstInitialState,
    ...currentTiming,
  })
  setupPresenceHandlers()

  onCleanup(() => {
    presence.stop()
  })

  const update = <Channel extends keyof State>(
    channel: Channel,
    msg: State[Channel]
  ) => {
    presence.broadcast(channel, msg)
    const updated = presence.getLocalState()
    setLocalState(reconcile(updated))
  }

  const start = (config?: Partial<PresenceConfig<State>>) => {
    const initialState = config?.initialState ?? presence.getLocalState()
    currentTiming = {
      heartbeatMs: config?.heartbeatMs ?? currentTiming.heartbeatMs,
      peerTtlMs: config?.peerTtlMs ?? currentTiming.peerTtlMs,
    }
    presence.start({
      initialState,
      ...currentTiming,
    })
    setupPresenceHandlers()
  }

  const stop = () => {
    presence.stop()
  }

  return {
    localState,
    peerStates,
    update,
    start,
    stop,
  }
}
