import { NetworkSimulator, NetworkConfig } from "./types.js"
import {
  PeerId,
  NetworkAdapterInterface,
  RepoMessage,
  NetworkAdapterEvents,
  PeerCandidatePayload,
  PeerMetadata,
} from "@automerge/automerge-repo/slim"

export class SimulatedNetworkAdapter implements NetworkAdapterInterface {
  private _isReady: boolean = false
  private _whenReady: Promise<void>
  private config: NetworkConfig
  private _peerId: PeerId
  private _listeners: Map<
    keyof NetworkAdapterEvents,
    ((...args: any[]) => void)[]
  >
  private _peerMetadata?: PeerMetadata

  constructor(config: NetworkConfig, peerId: PeerId) {
    this.config = config
    this._peerId = peerId
    this._whenReady = Promise.resolve()
    this._listeners = new Map()
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this._isReady = true
    this._peerMetadata = peerMetadata
    this.emit("peer-candidate", {
      peerId,
      peerMetadata: peerMetadata || {},
    } as PeerCandidatePayload)
  }

  disconnect(): void {
    this._isReady = false
  }

  isReady(): boolean {
    return this._isReady
  }

  whenReady(): Promise<void> {
    return this._whenReady
  }

  send(_message: RepoMessage): void {
    // This is a no-op since we handle sending in the SimulatedNetwork class
  }

  receive(_message: RepoMessage): void {
    // This is a no-op since we handle receiving in the SimulatedNetwork class
  }

  // EventEmitter methods
  eventNames(): (keyof NetworkAdapterEvents)[] {
    return Array.from(this._listeners.keys())
  }

  listeners<T extends keyof NetworkAdapterEvents>(
    event: T
  ): ((...args: any[]) => void)[] {
    return this._listeners.get(event) || []
  }

  listenerCount(event: keyof NetworkAdapterEvents): number {
    return this.listeners(event).length
  }

  emit(event: keyof NetworkAdapterEvents, ...args: any[]): boolean {
    const listeners = this._listeners.get(event)
    if (listeners) {
      listeners.forEach(listener => listener(...args))
      return true
    }
    return false
  }

  on<T extends keyof NetworkAdapterEvents>(
    event: T,
    fn: (...args: any[]) => void,
    _context?: any
  ): this {
    const listeners = this._listeners.get(event) || []
    listeners.push(fn)
    this._listeners.set(event, listeners)
    return this
  }

  once<T extends keyof NetworkAdapterEvents>(
    event: T,
    fn: (...args: any[]) => void,
    _context?: any
  ): this {
    const onceFn = (...args: any[]) => {
      fn(...args)
      this.off(event, onceFn)
    }
    return this.on(event, onceFn)
  }

  off<T extends keyof NetworkAdapterEvents>(
    event: T,
    fn?: ((...args: any[]) => void) | undefined,
    _context?: any,
    _once?: boolean
  ): this {
    if (fn) {
      const listeners = this._listeners.get(event) || []
      const index = listeners.indexOf(fn)
      if (index !== -1) {
        listeners.splice(index, 1)
        this._listeners.set(event, listeners)
      }
    } else {
      this._listeners.delete(event)
    }
    return this
  }

  removeAllListeners(event?: keyof NetworkAdapterEvents): this {
    if (event) {
      this._listeners.delete(event)
    } else {
      this._listeners.clear()
    }
    return this
  }

  addListener<T extends keyof NetworkAdapterEvents>(
    event: T,
    fn: (...args: any[]) => void,
    _context?: any
  ): this {
    return this.on(event, fn)
  }

  removeListener<T extends keyof NetworkAdapterEvents>(
    event: T,
    fn?: ((...args: any[]) => void) | undefined,
    _context?: any,
    _once?: boolean
  ): this {
    return this.off(event, fn)
  }
}

export class SimulatedNetwork implements NetworkSimulator {
  private adapters: Map<PeerId, SimulatedNetworkAdapter>
  private partitions: Set<string>
  private config: NetworkConfig

  constructor(config: NetworkConfig) {
    this.adapters = new Map()
    this.partitions = new Set()
    this.config = config
  }

  private getChannelKey(peer1: PeerId, peer2: PeerId): string {
    return [peer1, peer2].sort().join(":")
  }

  send(message: Uint8Array, to: PeerId): void {
    // Check if peers are partitioned
    const partitionKey = this.getChannelKey(this.config.peerId, to)
    if (this.partitions.has(partitionKey)) {
      return
    }

    // Simulate message loss
    if (Math.random() < (this.config.messageLoss || 0)) {
      return
    }

    // Simulate latency
    if (this.config.latency) {
      setTimeout(() => {
        const adapter = this.adapters.get(to)
        if (adapter) {
          adapter.receive(message as unknown as RepoMessage)
        }
      }, this.config.latency)
    } else {
      const adapter = this.adapters.get(to)
      if (adapter) {
        adapter.receive(message as unknown as RepoMessage)
      }
    }
  }

  partition(peerId: PeerId): void {
    const partitionKey = this.getChannelKey(this.config.peerId, peerId)
    this.partitions.add(partitionKey)
  }

  reconnect(peerId: PeerId): void {
    const partitionKey = this.getChannelKey(this.config.peerId, peerId)
    this.partitions.delete(partitionKey)
  }

  createAdapter(peerId: PeerId): SimulatedNetworkAdapter {
    const adapter = new SimulatedNetworkAdapter(this.config, peerId)
    this.adapters.set(peerId, adapter)

    // Connect to all other peers
    for (const [otherPeerId, otherAdapter] of this.adapters.entries()) {
      if (otherPeerId !== peerId) {
        adapter.connect(otherPeerId)
        otherAdapter.connect(peerId)
      }
    }

    return adapter
  }
}
