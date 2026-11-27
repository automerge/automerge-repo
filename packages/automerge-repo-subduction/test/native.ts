import type * as N from "@automerge/subduction"
import type { SubductionBackend } from "../src/index.js"

type Built = { node: N.Subduction; options: N.SubductionOptions }

/** Native nodes built by backends, by signer peer ID; the latest wins. Filled
 * by the `@automerge/subduction/slim` mock in `setup.ts`. */
export const nodes = new Map<string, Built>()

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("")

function built(backend: SubductionBackend): Built {
  const entry = nodes.get(backend.peerId)
  if (!entry) throw new Error(`No native node for ${backend.peerId}`)
  return entry
}

/** The native node most recently built for `backend`'s signer. */
export const nodeOf = (backend: SubductionBackend) => built(backend).node

/** The options `backend` built its native node with. */
export const optionsOf = (backend: SubductionBackend) => built(backend).options
