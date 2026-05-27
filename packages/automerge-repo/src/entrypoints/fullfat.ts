export * from "../index.js"

// The following import triggers the various mechanisms in @automerge/automerge
// which attempt to figure out what kind of environment we are in and
// initialize the wasm blob correspondingly. Note that our lint config
// restricts the non-slim import here, which we have to disable
//
// eslint-disable-next-line no-restricted-imports
import "@automerge/automerge"
