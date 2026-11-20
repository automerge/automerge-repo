// @ts-expect-error dist/index.d.ts omits initSync.
import { initSync as initKeyhive } from "@keyhive/keyhive/slim"
// @ts-expect-error The generated base64 module has no type declarations.
import { wasmBase64 as keyhiveWasmBase64 } from "@keyhive/keyhive/wasm-base64"

let initialized = false

/** Initialize the keyhive WASM module. Call before using any keyhive type. */
export function initKeyhiveWasm(): void {
  if (initialized) return
  initKeyhive({ module: fromBase64(keyhiveWasmBase64) })
  initialized = true
}

function fromBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
}
