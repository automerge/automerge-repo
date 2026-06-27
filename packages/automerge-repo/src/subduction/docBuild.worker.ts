/// <reference lib="webworker" />
/**
 * Worker that materialises an Automerge doc from merged blob bytes off the main
 * thread, then `save`s a compact snapshot and transfers it back — so the main
 * thread only pays a single `loadIncremental` of the (much smaller) snapshot
 * instead of applying every change. Spawned by {@link DocBuildWorkerClient}.
 *
 * Initialises Automerge the bundler-robust way: slim + base64 Wasm
 * (synchronous, no fetch / no `.wasm` import) — the fullfat auto-init hangs
 * inside a bundled Worker, and base64 means consumers don't need a Wasm plugin
 * for the worker bundle.
 */
import { initializeBase64Wasm, next as A } from "@automerge/automerge/slim"
// The base64 Wasm companion to the slim entrypoint — the lint config restricts
// the non-slim import, but here it is exactly what slim init consumes.
// eslint-disable-next-line no-restricted-imports
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"

import { DOC_BUILD_RPC, type DocBuildRequest } from "./docBuildRpc.js"

let initP: Promise<unknown> | null = null
const ensureReady = () =>
  (initP ??= Promise.resolve(initializeBase64Wasm(automergeWasmBase64)))

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data as DocBuildRequest
  if (!msg || msg.channel !== DOC_BUILD_RPC) return
  const post = (body: Record<string, unknown>, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage(
      { channel: DOC_BUILD_RPC, id: msg.id, ...body },
      transfer
    )
  const mergedBytes = msg.merged?.byteLength ?? 0
  const started = performance.now()
  try {
    await ensureReady()
    const t0 = performance.now()
    const doc = A.loadIncremental(A.init(), msg.merged)
    const t1 = performance.now()
    const snapshot = A.save(doc)
    const t2 = performance.now()
    post(
      {
        ok: true,
        snapshot,
        timing: {
          buildMs: t1 - t0,
          saveMs: t2 - t1,
          mergedBytes,
          snapshotBytes: snapshot.byteLength,
        },
      },
      [snapshot.buffer]
    )
  } catch (err) {
    post({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      mergedBytes,
      failedAfterMs: performance.now() - started,
    })
  }
}

export {}
