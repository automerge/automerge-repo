import * as Automerge from "@automerge/automerge/slim"
import {
  SedimentreeId,
  Subduction,
  Digest,
  SedimentreeAutomerge,
  FragmentStateStore,
  HashMetric,
  MemorySigner,
} from "@automerge/automerge-subduction/slim"
import { DocumentSource } from "../DocumentSource.js"
import { DocumentQuery } from "../DocumentQuery.js"
import { DocumentId } from "../types.js"
import { automergeMeta, toSedimentreeId } from "./helpers.js"
import { DocHandle } from "../index.js"
import { throttle } from "../helpers/throttle.js"
import { HashRing } from "../helpers/HashRing.js"
import debug from "debug"
import { SubductionStorageBridge } from "./storage.js"

export class SubductionSource implements DocumentSource {
  #subduction: Promise<Subduction>
  #storage: SubductionStorageBridge
  #handlesBySedimentreeId = new Map<string, DocHandle<unknown>>()
  #throttledBroadcasts: (() => void)[] = []
  #pendingOutbound: number = 0
  #lastHeadsSent: Map<string, Set<string>> = new Map()
  #outboundResolvers: (() => void)[] = []
  #recentlySeenHeads: Map<string, HashRing> = new Map()
  #recentHeadsCacheSize: number = 256
  #fragmentStateStore: FragmentStateStore = new FragmentStateStore()
  #log: debug.Debugger

  constructor(
    storage: SubductionStorageBridge,
    signer: any,
    websocketEndpoints: string[]
  ) {
    this.#log = debug(`automerge-repo:subduction`)
    this.#storage = storage
    this.#subduction = Subduction.hydrate(signer, storage).then(s => {
      for (const url of websocketEndpoints) {
        s.connectDiscover(new URL(url), signer)
      }
      return s
    })

    this.#storage.on("commit-saved", this.#handleDataFound)
    this.#storage.on("fragment-saved", this.#handleDataFound)
  }

  attach(query: DocumentQuery<unknown>): void {
    const sid = toSedimentreeId(query.documentId)
    this.#handlesBySedimentreeId.set(sid.toString(), query.handle)

    query.sourcePending("subduction")
    ;(async () => {
      const subduction = await this.#subduction
      const loadedBlobs = await subduction.getBlobs(sid)

      if (loadedBlobs) {
        const blobs = concatArrays(loadedBlobs)
        query.handle.update(d => {
          return Automerge.loadIncremental(d, blobs)
        })
      }
      this.#requestDocOverSubduction(query)
    })()

    const throttledBroadcast = throttle(() => {
      const doc = query.handle.doc()
      if (!doc) return
      this.#broadcast(doc, sid)
    }, 100)

    // Track for flushing in awaitOutbound()
    this.#throttledBroadcasts.push(throttledBroadcast)

    query.handle.on("heads-changed", () => {
      throttledBroadcast()
    })

    throttledBroadcast()
  }

  detach(documentId: DocumentId): void {}

  #handleDataFound(id: SedimentreeId, _digest: Digest, blob: Uint8Array) {
    const handle = this.#handlesBySedimentreeId.get(id.toString())
    if (!handle) return
    handle.update(d => {
      return Automerge.loadIncremental(d, blob)
    })
  }

  async #broadcast<T>(doc: Automerge.Doc<T>, sedimentreeId: SedimentreeId) {
    // Track this broadcast for awaitOutbound() BEFORE any awaits
    this.#pendingOutbound++

    try {
      const currentHexHeads = Automerge.getHeads(doc)
      const id = sedimentreeId.toString()
      const mostRecentHeads: Set<string> =
        this.#lastHeadsSent.get(id) || new Set()

      // Properly compare set contents (not identity)
      const currentSet = new Set(currentHexHeads)
      const headsAlreadySent =
        currentSet.size === mostRecentHeads.size &&
        [...currentSet].every(h => mostRecentHeads.has(h))
      if (headsAlreadySent) {
        return
      }

      const subduction = await this.#subduction

      await Promise.all(
        Automerge.getChangesMetaSince(doc, Array.from(mostRecentHeads)).map(
          async meta => {
            try {
              const cache =
                this.#recentlySeenHeads.get(id) ||
                new HashRing(this.#recentHeadsCacheSize)

              const hexHash = meta.hash
              if (!cache.add(hexHash)) return

              this.#recentlySeenHeads.set(id, cache)

              const commitBytes = automergeMeta(doc).getChangeByHash(hexHash)
              const parents = meta.deps.map(depHexHash =>
                Digest.fromHexString(depHexHash)
              )

              const maybeFragmentRequested = await subduction.addCommit(
                sedimentreeId,
                parents,
                commitBytes
              )

              if (maybeFragmentRequested === undefined) return

              const fragmentRequested = maybeFragmentRequested
              const head = fragmentRequested.head
              if (!head || !(head as any).__wbg_ptr) {
                this.#log(
                  "skipping buildFragmentStore: fragmentRequested.head is invalid (ptr=%s)",
                  (head as any)?.__wbg_ptr
                )
                return
              }

              const innerDoc = automergeMeta(doc)
              const sam = new SedimentreeAutomerge(innerDoc)

              // Build all missing fragments recursively, not just the top one.
              const fragmentStates = sam.buildFragmentStore(
                [head],
                this.#fragmentStateStore,
                new HashMetric()
              )

              for (const fragmentState of fragmentStates) {
                const members = fragmentState
                  .members()
                  .map((digest: Digest): string => digest.toHexString())

                // NOTE this is the only(?) function that we need from AM v3.2.0
                const fragmentBlob = Automerge.saveBundle(doc, members)

                await subduction.addFragment(
                  sedimentreeId,
                  fragmentState.head_digest(),
                  fragmentState.boundary().keys(),
                  fragmentState.checkpoints(),
                  fragmentBlob
                )
              }
            } catch (e) {
              // Best-effort: if addCommit or buildFragmentStore fails (e.g.,
              // partial history, detached Wasm memory), log and continue.
              // Commits are still stored; fragment compaction will retry later.
              console.warn(
                `[Repo] broadcast failed for change ${meta.hash} on ${id}:`,
                e
              )
            }
          }
        )
      )

      this.#lastHeadsSent.set(sedimentreeId.toString(), currentSet)
    } finally {
      this.#pendingOutbound--
      if (this.#pendingOutbound === 0) {
        this.#outboundResolvers.forEach(r => r())
        this.#outboundResolvers = []
      }
    }
  }

  async #requestDocOverSubduction(query: DocumentQuery<unknown>) {
    const subduction = await this.#subduction
    const sedimentreeId = toSedimentreeId(query.documentId)
    this.#handlesBySedimentreeId.set(sedimentreeId.toString(), query.handle)

    // With the 1.5RTT protocol, syncAll performs bidirectional sync in a single call:
    // 1. We send our summary to peers
    // 2. Peers respond with data we're missing AND tell us what they need
    // 3. We send back what they requested (handled internally by Subduction)
    this.#log(`syncing sedimentree ${sedimentreeId.toString().slice(0, 8)}...`)
    const peerResultMap = await subduction.syncAll(sedimentreeId, true)

    // Log sync statistics and any errors
    let receivedData = false
    for (const result of peerResultMap.entries()) {
      const stats = result.stats
      if (stats && !stats.isEmpty) {
        receivedData = true
        this.#log(
          `sync stats: received ${stats.commitsReceived} commits, ${stats.fragmentsReceived} fragments; ` +
            `sent ${stats.commitsSent} commits, ${stats.fragmentsSent} fragments`
        )
      }
      for (const errPair of result.connErrors || []) {
        this.#log("sync connection error:", errPair.err)
      }
      if (!result.success) {
        this.#log("sync failed for peer")
        return
      }
    }

    const hasPeers = peerResultMap.entries().length > 0
    if (peerResultMap.entries().every(peerResult => !peerResult.success)) {
      query.sourceUnavailable("subduction")
    } else {
      // the commit-saved or fragment-saved handlers on the storage will update the handle,
      // which will in turn transition it to a ready state
    }
  }
}

function concatArrays(loadedBlobs: Uint8Array<ArrayBufferLike>[]): Uint8Array {
  if (loadedBlobs.length === 0) return new Uint8Array(0)
  if (loadedBlobs.length === 1) return loadedBlobs[0]

  const totalLength = loadedBlobs.reduce((sum, blob) => sum + blob.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const blob of loadedBlobs) {
    result.set(blob, offset)
    offset += blob.length
  }
  return result
}
