import {
  PeerStateView,
  Presence,
  type PresenceConfig,
  type PresenceHandle,
  type PresenceState,
} from "@automerge/automerge-repo/slim"
import { onCleanup } from "solid-js"
import { createStore, reconcile, type Store } from "solid-js/store"

export type UsePresenceConfig<State extends PresenceState> =
  PresenceConfig<State> & {
    handle: PresenceHandle
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
  initialState,
  heartbeatMs,
  peerTtlMs,
}: UsePresenceConfig<State>): UsePresenceResult<State> {
  const [localState, setLocalState] = createStore<State>(initialState)
  const [peerStates, setPeerStates] = createStore(new PeerStateView<State>({}))
  const presence = new Presence<State>({ handle })
  let currentTiming = { heartbeatMs, peerTtlMs }

  // Presence keeps its own listeners across stop/start, so attach them once.
  const syncPeerStates = () =>
    setPeerStates(reconcile(presence.getPeerStates()))
  for (const event of [
    "heartbeat",
    "snapshot",
    "update",
    "goodbye",
    "pruning",
  ] as const) {
    presence.on(event, syncPeerStates)
  }

  presence.start({ initialState, ...currentTiming })

  onCleanup(() => {
    presence.stop()
    presence.removeAllListeners()
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
