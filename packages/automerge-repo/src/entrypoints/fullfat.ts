export * from "../index.js"

// The following import triggers the various mechanisms in @automerge/automerge
// which attempt to figure out what kind of environment we are in and
// initialize the wasm blob correspondingly. Note that we have a custom eslint
// rule which would complain about the non-slim import here which we have to
// disable
//
// eslint-disable-next-line automerge-slimport/enforce-automerge-slim-import
import { next as Am } from "@automerge/automerge"
Am.init()
