// Initialize the Automerge Wasm backend for the slim module.
// Importing the fat "@automerge/automerge" auto-calls UseApi() which
// registers the Wasm backend in the shared ApiHandler singleton.
// This must resolve to the same @automerge/automerge version that
// packages/automerge-repo uses (both should be ^3.2.4).
import { next as Automerge } from "@automerge/automerge"
import * as subduction from "@automerge/automerge-subduction"

// Verify both Wasm modules are loadable
const _doc = Automerge.init({})
const _signer = new subduction.MemorySigner()
