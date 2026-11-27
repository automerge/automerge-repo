export * from "../index.js"
export { initializeBase64Wasm, initializeWasm } from "@automerge/automerge/slim"
// The Automerge API Repo uses, so apps share its version and WASM instance.
export * as Automerge from "@automerge/automerge/slim"
