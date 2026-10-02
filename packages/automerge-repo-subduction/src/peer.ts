import * as N from "@automerge/subduction/slim"
import { SubductionBackend, type SubductionBackendOptions } from "./index.js"
import { MemoryByteStore } from "./MemoryByteStore.js"
import {
  connectSubductionServer,
  type SubductionConnection,
  type SubductionConnectionOptions,
  type SubductionServer,
} from "./connect.js"

export interface SubductionPeerOptions
  extends
    Omit<SubductionBackendOptions, "signer" | "storage">,
    SubductionConnectionOptions {
  signer?: SubductionBackendOptions["signer"]
  storage?: SubductionBackendOptions["storage"]
  servers?: readonly SubductionServer[]
}

export interface SubductionPeer {
  readonly backend: SubductionBackend
  readonly peerId: string
  readonly connections: readonly SubductionConnection[]
  connect(server: SubductionServer): SubductionConnection
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

/** Creates a backend and immediately connects configured servers using its identity. */
export function createSubductionPeer(
  options: SubductionPeerOptions = {}
): SubductionPeer {
  const ownedSigner = options.signer ? undefined : N.MemorySigner.generate()
  const signer = options.signer ?? ownedSigner!
  const connections: SubductionConnection[] = []
  let backend: SubductionBackend | undefined
  let closing: Promise<void> | undefined
  try {
    const id = new N.PeerId(signer.verifyingKey())
    let peerId: string
    try {
      peerId = id.toString()
    } finally {
      id.free()
    }
    backend = new SubductionBackend({
      ...options,
      signer,
      storage: options.storage ?? new MemoryByteStore(),
    })
    const peer: SubductionPeer = {
      backend,
      peerId,
      connections,
      connect(server) {
        if (closing) throw new Error("Subduction peer closed")
        const connection = connectSubductionServer(
          backend!,
          signer,
          server,
          options
        )
        connections.push(connection)
        return connection
      },
      close() {
        if (closing) return closing
        return (closing = Promise.resolve().then(async () => {
          const outcomes = await Promise.allSettled(
            connections.map(c => c.close())
          )
          try {
            await backend!.close()
          } catch (reason) {
            outcomes.push({ status: "rejected", reason })
          } finally {
            ownedSigner?.free()
          }
          const errors = outcomes.flatMap(o =>
            o.status === "rejected" ? [o.reason] : []
          )
          if (errors.length)
            throw new AggregateError(errors, "Subduction peer close failed")
        }))
      },
      [Symbol.asyncDispose]() {
        return peer.close()
      },
    }
    for (const server of options.servers ?? []) peer.connect(server)
    return peer
  } catch (cause) {
    // Validation can fail after some servers have started; keep the signer alive
    // until those attempts and the partially constructed backend have stopped.
    void (async () => {
      await Promise.allSettled(connections.map(c => c.close()))
      try {
        await backend?.close()
      } finally {
        ownedSigner?.free()
      }
    })().catch(() => {})
    throw cause
  }
}
