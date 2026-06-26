/// <reference lib="webworker" />
/**
 * Worker for the off-main-thread doc-building bench (DocBuild.browser.test.ts).
 *
 * Receives the merged incremental bytes (the concatenation of a sedimentree's
 * blobs — exactly what `#loadBlobsIntoHandle` feeds to
 * `Automerge.loadIncremental`), materialises the doc on ITS OWN thread, then
 * `save`s a compact snapshot and transfers it back. The main thread then only
 * pays a single `load` of the snapshot instead of applying every change.
 *
 * Initialises Automerge the bundler-robust way: slim entry + base64 Wasm
 * (synchronous, no fetch) — the fullfat auto-init hangs inside a Vite worker.
 */
import { initializeBase64Wasm, next as A } from "@automerge/automerge/slim"
// @ts-expect-error — the base64 Wasm module has no type declarations
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64"

let initP: Promise<unknown> | null = null
const ensureReady = () =>
  (initP ??= Promise.resolve(initializeBase64Wasm(automergeWasmBase64)))

self.onmessage = async (e: MessageEvent) => {
  await ensureReady()
  const merged = e.data.merged as Uint8Array
  const t0 = performance.now()
  const doc = A.loadIncremental(A.init(), merged)
  const snapshot = A.save(doc)
  const ms = performance.now() - t0
  ;(self as unknown as Worker).postMessage({ snapshot, ms }, [snapshot.buffer])
}

export {}
