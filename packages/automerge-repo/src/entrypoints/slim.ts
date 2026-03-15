export * from "../index.js"
export { initializeBase64Wasm, initializeWasm } from "@automerge/automerge/slim"
// TODO: temporary work-around during alpha.
export * as Automerge from "@automerge/automerge/slim"

// Subduction Wasm initialization:
//
// All consumers (slim AND fullfat) must initialize Subduction's Wasm
// manually and register the module before constructing a Repo.
// Always use the /slim sub-export to avoid the bundler.js dual-module
// class identity issue (see fullfat.ts for details).
//
//   import { initSync } from "@automerge/automerge-subduction/slim"
//   import * as subductionModule from "@automerge/automerge-subduction/slim"
//   import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"
//   import { setSubductionModule } from "@automerge/automerge-repo/slim"
//
//   initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
//   setSubductionModule(subductionModule)
