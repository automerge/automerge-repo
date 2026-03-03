export * from "../index.js"

// The following import triggers the various mechanisms in @automerge/automerge
// which attempt to figure out what kind of environment we are in and
// initialize the wasm blob correspondingly. Note that we have a custom eslint
// rule which would complain about the non-slim import here which we have to
// disable
//
// eslint-disable-next-line automerge-slimport/enforce-automerge-slim-import
import "@automerge/automerge"

// Auto-initialize Subduction's Wasm module and register it with automerge-repo.
// Importing the bare specifier triggers environment-based Wasm initialization
// (same pattern as @automerge/automerge above). The namespace import lets us
// pass the module to setSubductionModule() so Repo can access constructors.
import * as subductionModule from "@automerge/automerge-subduction"
import { setSubductionModule } from "../Repo.js"
setSubductionModule(subductionModule)
