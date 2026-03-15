export * from "../index.js"

// The following import triggers the various mechanisms in @automerge/automerge
// which attempt to figure out what kind of environment we are in and
// initialize the wasm blob correspondingly. Note that we have a custom eslint
// rule which would complain about the non-slim import here which we have to
// disable
//
// eslint-disable-next-line automerge-slimport/enforce-automerge-slim-import
import "@automerge/automerge"

// Subduction Wasm is NOT auto-initialized here.
//
// The bare "@automerge/automerge-subduction" import resolves to the
// `bundler.js` entrypoint under Vite's `browser` export condition.
// That entrypoint loads two separate wasm-bindgen glue modules
// (bundler/bg.js and web/), creating duplicate class definitions that
// break `instanceof` checks inside wasm-bindgen's `_assertClass`.
//
// Instead, consumers must:
//   1. import { initSync } from "@automerge/automerge-subduction/slim"
//   2. import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"
//   3. Call initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
//   4. Call initSubductionModule(module) from the bridge package
//
// See https://github.com/alexjg/wasm-bodge/issues/8
