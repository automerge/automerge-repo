export * from "../index.js"
export { initializeBase64Wasm, initializeWasm } from "@automerge/automerge/slim"
// TODO: temporary work-around during alpha.
export * as Automerge from "@automerge/automerge/slim"

// Subduction Wasm initialization for slim consumers:
//
// Slim consumers must initialize Subduction's Wasm manually and register
// the module before constructing a Repo:
//
//   import init from "@automerge/automerge-subduction/slim"
//   import * as subductionModule from "@automerge/automerge-subduction/slim"
//   import { setSubductionModule } from "@automerge/automerge-repo/slim"
//
//   await init(wasmUrl)
//   setSubductionModule(subductionModule)
//
// The fullfat entrypoint ("@automerge/automerge-repo") handles this
// automatically via a side-effect import.
