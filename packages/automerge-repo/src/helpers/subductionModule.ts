/**
 * Single source of truth for the Subduction Wasm module reference.
 *
 * This module is intentionally kept dependency-free (no imports from Repo,
 * DocHandle, etc.) so that external packages like automerge-repo-subduction-bridge
 * can import it without pulling in the entire Repo dependency graph.
 */

type SubductionModuleType = typeof import("@automerge/automerge-subduction")

let _subductionModule: SubductionModuleType | null = null

/**
 * Set the subduction module reference. Must be called after Wasm initialization
 * but before constructing a Repo.
 *
 * @example
 * ```ts
 * import { initSync } from "@automerge/automerge-subduction"
 * import * as subductionModule from "@automerge/automerge-subduction"
 * import { setSubductionModule } from "@automerge/automerge-repo"
 *
 * await initSync()
 * setSubductionModule(subductionModule)
 * // Now you can construct a Repo
 * ```
 */
export function setSubductionModule(module: SubductionModuleType): void {
  _subductionModule = module
}

export function getSubductionModule(): SubductionModuleType {
  if (_subductionModule === null) {
    throw new Error(
      "Subduction module not set. Call setSubductionModule() after Wasm initialization."
    )
  }
  return _subductionModule
}
