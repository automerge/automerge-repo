/**
 * Wire-level instrumentation for Subduction sync tests.
 *
 * Counts every frame a client (or the in-process server) sends and
 * receives, classifies it by Subduction message tag, and decodes the
 * parts of `BatchSyncResponse` the throughput tests need. Nothing here
 * changes behaviour: the metered transport forwards every call unchanged.
 *
 * Frame layout (subduction_core/src/connection/message.rs):
 *
 *   "SUM\0" | u32 length | u8 tag | payload
 *
 * Handshake ("SUH\0") and ephemeral ("SUE\0") frames use other magics and
 * are classified as `handshake` / `ephemeral`.
 */

import { once } from "events"
import { WebSocketServer } from "ws"
import {
  Subduction,
  MemorySigner,
  MemoryStorage,
  SignedFragment,
  SignedLooseCommit,
} from "@automerge/automerge-subduction"
import type { Transport } from "@automerge/automerge-subduction/slim"
import { WebSocketTransport } from "../../src/subduction/websocket-transport.js"
import type {
  ManagedTransport,
  WebSocketEndpointInterface,
} from "../../src/subduction/websocket-endpoint.js"

// ── Frame classification ──────────────────────────────────────────────

export const SYNC_TAGS = {
  0: "LooseCommit",
  1: "Fragment",
  4: "BatchSyncRequest",
  5: "BatchSyncResponse",
  6: "RemoveSubscriptions",
  7: "DataRequestRejected",
  8: "HeadsUpdate",
} as const

export type FrameKind =
  | (typeof SYNC_TAGS)[keyof typeof SYNC_TAGS]
  | "handshake"
  | "ephemeral"
  | "other"

const SUM_HEADER = 9 // "SUM\0" + u32 length + u8 tag

function hasMagic(b: Uint8Array, m: string): boolean {
  return (
    b.length >= 4 &&
    b[0] === m.charCodeAt(0) &&
    b[1] === m.charCodeAt(1) &&
    b[2] === m.charCodeAt(2) &&
    b[3] === 0
  )
}

export function frameKind(bytes: Uint8Array): FrameKind {
  if (hasMagic(bytes, "SUM") && bytes.length >= SUM_HEADER) {
    return SYNC_TAGS[bytes[8] as keyof typeof SYNC_TAGS] ?? "other"
  }
  if (hasMagic(bytes, "SUH")) return "handshake"
  if (hasMagic(bytes, "SUE")) return "ephemeral"
  return "other"
}

// ── Meters ────────────────────────────────────────────────────────────

export type Direction = "up" | "down"

export interface Frame {
  dir: Direction
  kind: FrameKind
  bytes: Uint8Array
}

/**
 * Time of the most recent frame seen by *any* meter in this process. Used
 * by {@link settle} to wait for the whole system (clients + server +
 * MessagePorts) to go quiet.
 */
let lastFrameAt = 0

/** Records every frame on one endpoint ("up" = sent, "down" = received). */
export class WireMeter {
  readonly frames: Frame[] = []

  constructor(readonly name: string) {}

  record(
    dir: Direction,
    bytes: Uint8Array,
    kind: FrameKind = frameKind(bytes)
  ) {
    this.frames.push({ dir, kind, bytes })
    lastFrameAt = Date.now()
  }

  /** A position in the frame log; pass to {@link since}. */
  mark(): number {
    return this.frames.length
  }

  /** Frames recorded after `mark` (default: all of them). */
  since(mark = 0): WireWindow {
    return new WireWindow(this.frames.slice(mark))
  }
}

/** A slice of a meter's frame log with counting helpers. */
export class WireWindow {
  constructor(readonly frames: Frame[]) {}

  select(dir: Direction, kind?: FrameKind): Frame[] {
    return this.frames.filter(
      f => f.dir === dir && (kind === undefined || f.kind === kind)
    )
  }

  count(dir: Direction, kind?: FrameKind): number {
    return this.select(dir, kind).length
  }

  bytes(dir: Direction, kind?: FrameKind): number {
    return this.select(dir, kind).reduce((n, f) => n + f.bytes.byteLength, 0)
  }

  /** Total frames in both directions, excluding nothing. */
  get total(): number {
    return this.frames.length
  }

  /** Compact `{ "up BatchSyncRequest": "2×220B", ... }` view for messages. */
  describe(): Record<string, string> {
    const out: Record<string, { n: number; b: number }> = {}
    for (const f of this.frames) {
      const k = `${f.dir} ${f.kind}`
      out[k] ??= { n: 0, b: 0 }
      out[k].n++
      out[k].b += f.bytes.byteLength
    }
    return Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, `${v.n}×, ${v.b}B`])
    )
  }
}

/** Forwards to an inner transport, recording every frame on `meter`. */
export class MeteredTransport implements ManagedTransport {
  constructor(
    readonly inner: WebSocketTransport,
    readonly meter: WireMeter,
    /** Which direction `sendBytes` represents for this meter. */
    readonly sendDir: Direction = "up"
  ) {}

  async sendBytes(bytes: Uint8Array): Promise<void> {
    this.meter.record(this.sendDir, bytes)
    return this.inner.sendBytes(bytes)
  }

  async recvBytes(): Promise<Uint8Array> {
    const bytes = await this.inner.recvBytes()
    this.meter.record(this.sendDir === "up" ? "down" : "up", bytes)
    return bytes
  }

  disconnect(): Promise<void> {
    return this.inner.disconnect()
  }

  onDisconnect(callback: () => void): void {
    this.inner.onDisconnect(callback)
  }

  closed(): Promise<void> {
    return this.inner.closed()
  }
}

/** A client endpoint whose every connection is metered. */
export class MeteredEndpoint implements WebSocketEndpointInterface {
  readonly meter: WireMeter
  connections = 0
  #current: MeteredTransport | null = null

  constructor(
    readonly url: string,
    name: string
  ) {
    this.meter = new WireMeter(name)
  }

  async connect(): Promise<ManagedTransport> {
    const inner = await WebSocketTransport.connect(this.url)
    this.connections++
    this.#current = new MeteredTransport(inner, this.meter)
    return this.#current
  }

  /** Drop the live socket; the Repo's reconnect loop will open a new one. */
  async dropConnection(): Promise<void> {
    await this.#current?.disconnect()
  }
}

/**
 * Count the automerge sync payloads posted on a MessagePort (the `data`
 * field of repo messages; the adapter sends it as a transferred
 * ArrayBuffer, so it is copied before the post detaches it).
 */
export function meterMessagePort(port: MessagePort, meter: WireMeter) {
  const post = port.postMessage.bind(port)
  port.postMessage = ((message: any, ...rest: any[]) => {
    const data = message?.data
    // `instanceof` is unreliable across realms (happy-dom), so duck-type.
    if (data != null && typeof data.byteLength === "number") {
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data)
      meter.record("up", bytes.slice(), "other")
    }
    return (post as any)(message, ...rest)
  }) as typeof port.postMessage
}

// ── In-process server ─────────────────────────────────────────────────

export interface MeteredServer {
  url: string
  subduction: Subduction
  /** Every frame on every server connection; "up" = server → client. */
  meter: WireMeter
  close(): Promise<void>
}

/**
 * The same in-process server the other subduction tests use (wasm
 * `Subduction` + `MemoryStorage` behind a `ws` server), with every
 * accepted connection metered.
 */
export async function startMeteredServer(): Promise<MeteredServer> {
  const subduction = new Subduction({
    signer: new MemorySigner(),
    storage: new MemoryStorage(),
  })
  const wss = new WebSocketServer({ port: 0 })
  await once(wss, "listening")
  const address = wss.address()
  if (address === null || typeof address === "string") {
    throw new Error("unexpected address type")
  }
  const { port } = address
  const meter = new WireMeter("server")

  wss.on("connection", ws => {
    const transport = new MeteredTransport(
      new WebSocketTransport(ws as any),
      meter
    )
    subduction
      .acceptTransport(transport as Transport, `localhost:${port}`)
      .catch(() => {})
  })

  return {
    url: `ws://localhost:${port}`,
    subduction,
    meter,
    async close() {
      await subduction.disconnectAll()
      await new Promise<void>((resolve, reject) =>
        wss.close(err => (err ? reject(err) : resolve()))
      )
    },
  }
}

// ── Pending timers ────────────────────────────────────────────────────

/**
 * Every deferred action in the sync path — the 100 ms save throttle, a
 * re-armed sync round, a heal retry, the reconnect backoff — is a
 * `setTimeout`. Tracking the ones still pending lets {@link settle} wait
 * for work that has been *scheduled* but has not produced a frame yet,
 * however long its delay, instead of guessing a quiet window that is
 * longer than every delay in the code.
 *
 * `settle` ignores timeouts longer than {@link SETTLE_DELAY_CAP_MS}:
 * those are request timeouts and similar guards that get cleared when the
 * request completes. The idle check still sees them.
 */
const SETTLE_DELAY_CAP_MS = 10_000

export interface PendingTimer {
  delay: number
  /** Order of creation; compare with {@link timerMark}. */
  seq: number
  /** Where it was scheduled, for the settle timeout message. */
  stack: string
}

let timerSeq = 0
/** A position in timer creation order: pass to the `since` filters. */
export const timerMark = () => timerSeq

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval
const pendingTimers = new Map<unknown, PendingTimer>()
const liveIntervals = new Map<unknown, PendingTimer>()

/** Node timers are objects but may be cleared by their numeric id. */
function forget(map: Map<unknown, PendingTimer>, handle: unknown) {
  if (map.delete(handle)) return
  if (typeof handle !== "number") return
  for (const key of map.keys()) {
    if (Number(key) === handle) {
      map.delete(key)
      return
    }
  }
}

let timersTracked = false

/**
 * Wrap the global timer functions so pending timeouts and live intervals
 * can be listed. Behaviour is unchanged. Idempotent; scoped to the test
 * file's worker, like any other global the file touches.
 */
export function trackTimers() {
  if (timersTracked) return
  timersTracked = true
  globalThis.setTimeout = ((
    fn: (...a: any[]) => void,
    delay = 0,
    ...args: any[]
  ) => {
    const handle: unknown = realSetTimeout(
      (...a: any[]) => {
        pendingTimers.delete(handle)
        fn(...a)
      },
      delay,
      ...args
    )
    pendingTimers.set(handle, {
      delay,
      seq: ++timerSeq,
      stack: new Error().stack ?? "",
    })
    return handle
  }) as typeof setTimeout
  globalThis.clearTimeout = ((handle: unknown) => {
    forget(pendingTimers, handle)
    return realClearTimeout(handle as any)
  }) as typeof clearTimeout
  globalThis.setInterval = ((
    fn: (...a: any[]) => void,
    delay = 0,
    ...args: any[]
  ) => {
    const handle: unknown = realSetInterval(fn, delay, ...args)
    liveIntervals.set(handle, {
      delay,
      seq: ++timerSeq,
      stack: new Error().stack ?? "",
    })
    return handle
  }) as typeof setInterval
  globalThis.clearInterval = ((handle: unknown) => {
    forget(liveIntervals, handle)
    return realClearInterval(handle as any)
  }) as typeof clearInterval
}

/** Timeouts scheduled after `mark` and not yet fired or cleared, of any delay. */
export function pendingTimeouts(mark = 0): PendingTimer[] {
  return [...pendingTimers.values()].filter(t => t.seq > mark)
}

/** Pending timeouts that {@link settle} waits for. */
function settleBlockers(): PendingTimer[] {
  return pendingTimeouts().filter(t => t.delay <= SETTLE_DELAY_CAP_MS)
}

/** Intervals created after `mark` and not cleared: a heartbeat or poll would show here. */
export function activeIntervals(mark = 0): PendingTimer[] {
  return [...liveIntervals.values()].filter(t => t.seq > mark)
}

const sleep = (ms: number) => new Promise(r => realSetTimeout(r, ms))

// ── Quiescence ────────────────────────────────────────────────────────

/**
 * Resolve once the system is idle: no timeout is pending (so no throttled
 * save, re-armed round or backoff is still to come) *and* no metered
 * frame has been seen anywhere for `quietMs` (so nothing is in flight on
 * a socket or inside the server).
 *
 * The pending-timer check is what makes this a completion signal rather
 * than a silence heuristic: a regression that delays a round by any
 * amount still lands inside the measurement window. The quiet window only
 * covers the gaps between a frame arriving and the promise chain that
 * reacts to it. Requires {@link trackTimers}. No test asserts on elapsed
 * time.
 */
export async function settle({
  quietMs = 250,
  timeoutMs = 20_000,
} = {}): Promise<void> {
  if (!timersTracked) throw new Error("settle: call trackTimers() first")
  const start = Date.now()
  // Give a just-triggered action a chance to emit its first frame.
  lastFrameAt = Math.max(lastFrameAt, start)
  for (;;) {
    const quiet = Date.now() - lastFrameAt >= quietMs
    if (quiet && settleBlockers().length === 0) return
    if (Date.now() - start > timeoutMs) {
      const timers = settleBlockers()
        .map(t => `  ${t.delay}ms ${t.stack.split("\n").slice(2, 5).join(" ")}`)
        .join("\n")
      throw new Error(
        `settle: system did not go idle within ${timeoutMs}ms ` +
          `(quiet=${quiet}; pending timeouts:\n${timers || "  none"})`
      )
    }
    await sleep(20)
  }
}

// ── Message decoding ──────────────────────────────────────────────────

function bijou64(b: Uint8Array, off: number): [value: number, len: number] {
  const x = b[off]
  if (x < 248) return [x, 1]
  const tier = x - 247
  let offset = 248
  let pow = 1
  for (let n = 2; n <= tier; n++) {
    pow *= 256
    offset += pow
  }
  let v = 0
  for (let i = 0; i < tier; i++) v = v * 256 + b[off + 1 + i]
  return [v + offset, 1 + tier]
}

const SIGNED_PREFIX = 4 + 32 // schema + verifying key
const SIGNATURE = 64

/** Byte length of the `Signed<LooseCommit>` starting at `o`. */
function signedLooseCommitLen(b: Uint8Array, o: number): number {
  // fields: sedimentree id 32 | head 32 | blob digest 32 | u8 #parents |
  //         bijou64 blob size | parents 32×n
  const f = o + SIGNED_PREFIX
  const nParents = b[f + 96]
  const [, sizeLen] = bijou64(b, f + 97)
  return SIGNED_PREFIX + 97 + sizeLen + 32 * nParents + SIGNATURE
}

/** Byte length of the `Signed<Fragment>` starting at `o`. */
function signedFragmentLen(b: Uint8Array, o: number): number {
  // fields: sedimentree id 32 | head 32 | blob digest 32 | u8 #boundary |
  //         u16 #checkpoints | bijou64 blob size | boundary 32×n |
  //         checkpoints 12×m
  const f = o + SIGNED_PREFIX
  const nBoundary = b[f + 96]
  const nCheckpoints = (b[f + 97] << 8) | b[f + 98]
  const [, sizeLen] = bijou64(b, f + 99)
  return (
    SIGNED_PREFIX +
    99 +
    sizeLen +
    32 * nBoundary +
    12 * nCheckpoints +
    SIGNATURE
  )
}

export interface ResponseCommit {
  id: string
  parents: string[]
  /** Size of the signed envelope (metadata + signature), excluding blob. */
  envelopeBytes: number
  blobBytes: number
}

export interface ResponseFragment {
  head: string
  boundary: string[]
  envelopeBytes: number
  blobBytes: number
}

export interface DecodedBatchSyncResponse {
  ok: boolean
  commits: ResponseCommit[]
  fragments: ResponseFragment[]
  requestedCommits: number
  requestedFragments: number
  responderHeads: number
}

/**
 * Decode a `BatchSyncResponse` frame. Each signed item is handed to the
 * wasm decoder (`SignedLooseCommit.tryDecode` / `SignedFragment.tryDecode`),
 * so a layout mismatch fails loudly instead of miscounting.
 */
export function decodeBatchSyncResponse(
  frame: Uint8Array
): DecodedBatchSyncResponse {
  if (frameKind(frame) !== "BatchSyncResponse") {
    throw new Error("not a BatchSyncResponse frame")
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  let o = SUM_HEADER + 32 + 8 + 32 // requestor, nonce, sedimentree id
  const result = frame[o++]
  const out: DecodedBatchSyncResponse = {
    ok: result === 0,
    commits: [],
    fragments: [],
    requestedCommits: 0,
    requestedFragments: 0,
    responderHeads: 0,
  }
  if (result !== 0) {
    out.responderHeads = dv.getUint32(o + 8)
    return out
  }
  const nCommits = dv.getUint16(o)
  const nFragments = dv.getUint16(o + 2)
  out.requestedCommits = dv.getUint16(o + 4)
  out.requestedFragments = dv.getUint16(o + 6)
  o += 8

  for (let i = 0; i < nCommits; i++) {
    const len = signedLooseCommitLen(frame, o)
    const signed = SignedLooseCommit.tryDecode(frame.slice(o, o + len))
    const c = signed.payload
    o += len
    const [blobLen, sizeLen] = bijou64(frame, o)
    o += sizeLen + blobLen
    out.commits.push({
      id: c.commitId.toHexString(),
      parents: c.parents.map(p => p.toHexString()),
      envelopeBytes: len + sizeLen,
      blobBytes: blobLen,
    })
  }
  for (let i = 0; i < nFragments; i++) {
    const len = signedFragmentLen(frame, o)
    const signed = SignedFragment.tryDecode(frame.slice(o, o + len))
    const f = signed.payload
    o += len
    const [blobLen, sizeLen] = bijou64(frame, o)
    o += sizeLen + blobLen
    out.fragments.push({
      head: f.head.toHexString(),
      boundary: f.boundary.map(b => b.toHexString()),
      envelopeBytes: len + sizeLen,
      blobBytes: blobLen,
    })
  }
  o += 8 * (out.requestedCommits + out.requestedFragments)
  out.responderHeads = dv.getUint32(o + 8) // after u64 counter
  return out
}

/**
 * Number of fingerprints (commit + fragment) in a `BatchSyncRequest`: the
 * size of the summary a requester sends to say what it already has.
 * Throws if the frame length does not match, so a layout change fails
 * loudly instead of miscounting.
 */
export function batchSyncRequestItems(frame: Uint8Array): number {
  if (frameKind(frame) !== "BatchSyncRequest") {
    throw new Error("not a BatchSyncRequest frame")
  }
  // id 32 | requestor 32 | nonce 8 | subscribe 1 | seed 16 | u16 | u16 |
  // u64 × (commits + fragments)
  const o = SUM_HEADER + 32 + 32 + 8 + 1 + 16
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const items = dv.getUint16(o) + dv.getUint16(o + 2)
  if (frame.byteLength !== o + 4 + 8 * items) {
    throw new Error(
      `BatchSyncRequest layout mismatch: ${frame.byteLength} B for ${items} items`
    )
  }
  return items
}

/** Fixed part of a `HeadsUpdate` frame: header, sedimentree id, counter, count. */
export const HEADS_UPDATE_ENVELOPE = SUM_HEADER + 32 + 8 + 4

/**
 * Number of heads listed in a `HeadsUpdate` frame (the frame is
 * {@link HEADS_UPDATE_ENVELOPE} + 32 bytes per head). Throws on a layout
 * mismatch.
 */
export function headsUpdateHeads(frame: Uint8Array): number {
  if (frameKind(frame) !== "HeadsUpdate") {
    throw new Error("not a HeadsUpdate frame")
  }
  const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  const heads = dv.getUint32(SUM_HEADER + 32 + 8)
  if (frame.byteLength !== HEADS_UPDATE_ENVELOPE + 32 * heads) {
    throw new Error(
      `HeadsUpdate layout mismatch: ${frame.byteLength} B for ${heads} heads`
    )
  }
  return heads
}
