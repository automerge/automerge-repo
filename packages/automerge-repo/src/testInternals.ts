/**
 * Test-only escape hatch. This module is NOT re-exported from
 * `src/index.ts`, so external consumers can't reach the symbol — they'd
 * have to deep-import via the source path, which is not part of the
 * supported public API.
 *
 * Tests that need to assert on internal `#`-private state import
 * `testInternals` from here and invoke a class's static method
 * `[testInternals](instance)` to obtain a view of that state.
 *
 * @example
 *   // In src/Repo.ts
 *   import { testInternals } from "./testInternals.js"
 *
 *   class Repo {
 *     static [testInternals](repo: Repo) {
 *       return { syncStateTracker: repo.#syncStateTracker }
 *     }
 *   }
 *
 *   // In a test
 *   import { testInternals } from "../src/testInternals.js"
 *   const internals = Repo[testInternals](repo)
 *   expect(internals.syncStateTracker.get(id)).toBeUndefined()
 */
export const testInternals = Symbol("automerge-repo:testInternals")
