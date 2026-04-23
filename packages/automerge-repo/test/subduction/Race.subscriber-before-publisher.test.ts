/**
 * Reproduces the "subscriber-before-publisher" race in `SubductionSource`.
 *
 * Topology: three repos over in-memory `MessageChannel`s.
 *
 *     ┌──────────┐          ┌──────────┐          ┌──────────┐
 *     │  peer A  │◀───mc───▶│  peer S  │◀───mc───▶│  peer B  │
 *     │publisher │          │  server  │          │subscriber│
 *     │ "connect"│          │ "accept" │          │ "connect"│
 *     └──────────┘          └──────────┘          └──────────┘
 *
 * Bug: when peer B calls `repo.find(url)` for a document that peer A has
 * just created locally but has not yet pushed to peer S,
 * `SubductionSource.#recomputeEntry` / `#loadBlobsAndTransition` transitions
 * peer B's `DocumentQuery` to terminal `"unavailable"` and `repo.find`
 * rejects with `Error: Document <id> is unavailable` — before peer A's
 * throttled `addCommit` + `syncWithAllPeers(..., true)` has a chance to
 * propagate the commits via peer S.
 *
 * Marked `it.fails` because on the current `subduction` branch this test
 * body deterministically throws. Remove `.fails` once a fix lands
 * (candidate fixes in `source.ts`:
 *   1. new `pushDoc` primitive awaited by the publisher before the
 *      subscriber `find`s;
 *   2. `#loadBlobsAndTransition` grace window on a never-delivered
 *      sedimentree instead of a terminal `sourceUnavailable` on the first
 *      empty sync;
 *   3. ensure `addCommit` has been flushed + synced before the first
 *      subscriber-initiated `#doSync` can observe an empty remote.)
 */

import { describe, it, expect, afterEach, vi } from "vitest"
import { MessageChannelNetworkAdapter } from "../../../automerge-repo-network-messagechannel/src/index.js"
import { Repo } from "../../src/Repo.js"
import { DummyStorageAdapter } from "../../src/helpers/DummyStorageAdapter.js"
import { type PeerId } from "../../src/types.js"
import { pause } from "../../src/helpers/pause.js"

describe("SubductionSource subscriber-before-publisher race", () => {
  const cleanups: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch {
        // best-effort teardown
      }
    }
    cleanups.length = 0
  })

  function openThreeRepos() {
    const channelAS = new MessageChannel()
    const channelBS = new MessageChannel()
    cleanups.push(() => channelAS.port1.close())
    cleanups.push(() => channelBS.port1.close())

    const serviceName = "race-test"

    const repoS = new Repo({
      peerId: "S" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      subductionAdapters: [
        {
          adapter: new MessageChannelNetworkAdapter(channelAS.port2),
          serviceName,
          role: "accept",
        },
        {
          adapter: new MessageChannelNetworkAdapter(channelBS.port2),
          serviceName,
          role: "accept",
        },
      ],
      sharePolicy: async () => true,
    })

    const repoA = new Repo({
      peerId: "A" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      subductionAdapters: [
        {
          adapter: new MessageChannelNetworkAdapter(channelAS.port1),
          serviceName,
        },
      ],
      sharePolicy: async () => true,
    })

    const repoB = new Repo({
      peerId: "B" as PeerId,
      storage: new DummyStorageAdapter(),
      network: [],
      subductionAdapters: [
        {
          adapter: new MessageChannelNetworkAdapter(channelBS.port1),
          serviceName,
        },
      ],
      sharePolicy: async () => true,
    })

    cleanups.push(() => repoA.shutdown())
    cleanups.push(() => repoB.shutdown())
    cleanups.push(() => repoS.shutdown())

    return { repoA, repoB, repoS }
  }

  it(
    "peer B finds a doc peer A just created — should resolve, today rejects unavailable",
    async () => {
      const { repoA, repoB } = openThreeRepos()

      // Let the two handshakes (A↔S, B↔S) settle so authentication state
      // is stable when peer A creates the doc.
      await pause(250)

      // Publisher creates + mutates. The change is in peer A's in-memory
      // `DocHandle`, but `throttledSave` debounces `addCommit` by 100ms,
      // so peer S has zero blobs for this sedimentree at the moment
      // peer B runs its first `syncWithAllPeers` round.
      const docA = repoA.create<{ foo: number }>()
      docA.change(d => {
        d.foo = 1
      })

      // Subscriber asks immediately — the exact pattern a real client uses
      // after reload: "here's the URL, hand me the content."
      //
      // We use `findWithProgress` rather than `find` because `find`'s
      // promise rejects terminally when the query passes through
      // `"unavailable"` (same rejection logic in `DocumentQuery.whenReady`
      // / `DocumentProgress.whenReady`). A `DocumentQuery` itself CAN
      // recover `unavailable → loading → ready` via
      // `SubductionSource.#handleDataFound` → `sourcePending`, so polling
      // `peek()` observes the recovery — when it happens.
      //
      // Expected: peer A's throttled save pushes blobs to peer S, peer S
      // forwards to peer B via subduction's subscription, peer B's query
      // reaches `"ready"` with `{ foo: 1 }`.
      //
      // Actual (current `subduction` branch): `#loadBlobsAndTransition`
      // marks peer B's query `"unavailable"` before peer A's 100ms
      // throttle fires, and the recovery does not land within the
      // timeout — `vi.waitFor` below throws, failing the test.
      const progressB = repoB.findWithProgress<{ foo: number }>(docA.url)
      await vi.waitFor(
        () => {
          const s = progressB.peek().state
          if (s !== "ready") throw new Error(`state=${s}`)
        },
        { timeout: 3000, interval: 25 }
      )
      const ready = progressB.peek()
      if (ready.state !== "ready") throw new Error("unreachable")
      expect(ready.handle.doc()).toEqual({ foo: 1 })
    },
    10_000
  )
})
