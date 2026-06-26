/** Message protocol shared by {@link DocBuildWorkerClient} (main thread) and
 * `docBuild.worker.ts` (the Worker that materialises an Automerge doc from
 * merged blob bytes and returns a compact snapshot). */

export const DOC_BUILD_RPC = "automerge-repo-doc-build-rpc" as const

export interface DocBuildRequest {
  channel: typeof DOC_BUILD_RPC
  id: number
  /** Concatenated blob bytes (the same input to `Automerge.loadIncremental`). */
  merged: Uint8Array
}

export type DocBuildResponse = {
  channel: typeof DOC_BUILD_RPC
  id: number
} & ({ ok: true; snapshot: Uint8Array } | { ok: false; error: string })
