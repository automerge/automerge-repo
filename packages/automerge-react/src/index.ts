// The default entrypoint intentionally initializes Automerge's WASM runtime.
// eslint-disable-next-line no-restricted-imports
export * from "@automerge/automerge-repo"
export * from "./default-exports.js"

// The default entrypoint initializes the native backend as well as Automerge.
import "@automerge/subduction"
