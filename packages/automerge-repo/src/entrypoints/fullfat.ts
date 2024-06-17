export * from "../index.js"
// This triggers the various mechanisms in @automerge/automerge which attempt
// to figure out what kind of environment we are in and initialize the wasm
// blob correspondingly
import { next as Am } from "@automerge/automerge"
Am.init()
