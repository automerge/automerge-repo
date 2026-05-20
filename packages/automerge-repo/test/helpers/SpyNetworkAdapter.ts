/**
 * A {@link DummyNetworkAdapter} that counts every message it sends and
 * receives, bucketed by whether the frame carries Subduction protocol
 * traffic (`type === SUBDUCTION_MESSAGE_TYPE`) or adapter-control
 * traffic (`arrive`/`welcome`/`leave`).
 *
 * Used by the message-budget test to measure per-direction,
 * per-document subduction frame counts and byte volumes without
 * touching the real `Subduction` protocol or transport code paths.
 *
 * Use {@link SpyNetworkAdapter.createConnectedPair} to obtain a paired
 * spy adapter — same shape as
 * {@link DummyNetworkAdapter.createConnectedPair} but with stats on
 * each side.
 */
import { DummyNetworkAdapter } from "../../src/helpers/DummyNetworkAdapter.js"
import { Message } from "../../src/index.js"
import { pause } from "../../src/helpers/pause.js"
import { SUBDUCTION_MESSAGE_TYPE } from "../../src/subduction/network.js"

export interface DirectionStats {
  frames: number
  bytes: number
  /** Per-frame `data.byteLength`, in send order. */
  sizes: number[]
}

export interface ControlStats {
  frames: number
  bytes: number
}

export interface AdapterStatsSnapshot {
  /** Subduction-typed frames this adapter sent. */
  out: DirectionStats
  /** Subduction-typed frames this adapter received. */
  in: DirectionStats
  /** Non-subduction (`arrive`/`welcome`/`leave`) frames sent + received. */
  control: ControlStats
}

const emptyDirection = (): DirectionStats => ({ frames: 0, bytes: 0, sizes: [] })
const emptyControl = (): ControlStats => ({ frames: 0, bytes: 0 })

export class SpyNetworkAdapter extends DummyNetworkAdapter {
  #out: DirectionStats = emptyDirection()
  #in: DirectionStats = emptyDirection()
  #control: ControlStats = emptyControl()

  override send(message: Message) {
    this.#record("out", message)
    super.send(message)
  }

  override receive(message: Message) {
    this.#record("in", message)
    super.receive(message)
  }

  #record(direction: "in" | "out", message: Message) {
    if (message.type === SUBDUCTION_MESSAGE_TYPE) {
      const size = message.data?.byteLength ?? 0
      const bucket = direction === "out" ? this.#out : this.#in
      bucket.frames++
      bucket.bytes += size
      bucket.sizes.push(size)
    } else {
      this.#control.frames++
      this.#control.bytes += message.data?.byteLength ?? 0
    }
  }

  snapshot(): AdapterStatsSnapshot {
    return {
      out: cloneDirection(this.#out),
      in: cloneDirection(this.#in),
      control: { ...this.#control },
    }
  }

  /**
   * Paired spies. Mirrors
   * {@link DummyNetworkAdapter.createConnectedPair} so the only
   * difference is the spy bookkeeping.
   */
  static override createConnectedPair({
    latency = 0,
  }: { latency?: number } = {}): [SpyNetworkAdapter, SpyNetworkAdapter] {
    const a: SpyNetworkAdapter = new SpyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        latency > 0
          ? pause(latency).then(() => b.receive(message))
          : void b.receive(message),
    })
    const b: SpyNetworkAdapter = new SpyNetworkAdapter({
      startReady: true,
      sendMessage: (message: Message) =>
        latency > 0
          ? pause(latency).then(() => a.receive(message))
          : void a.receive(message),
    })
    return [a, b]
  }
}

function cloneDirection(d: DirectionStats): DirectionStats {
  return { frames: d.frames, bytes: d.bytes, sizes: [...d.sizes] }
}
