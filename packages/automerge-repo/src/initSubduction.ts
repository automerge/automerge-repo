let initPromise: Promise<void> | null = null

/**
 * Initialize the Subduction Wasm module ahead of time. This can be
 * called before constructing a Repo when an application wants to
 * eagerly load the Wasm module. Safe to call multiple times
 * (idempotent, concurrent calls share the same import).
 *
 * This performs a dynamic import of `@automerge/automerge-subduction`
 * (the non-`/slim` entry), which auto-initializes the Wasm module as
 * a side effect. The `/slim` entry used internally by the Repo shares
 * the same module-scoped Wasm instance, so this pre-initialization is
 * visible there as well.
 */
export async function initSubduction(): Promise<void> {
  if (!initPromise) {
    initPromise = import("@automerge/automerge-subduction")
      .then(() => {})
      .catch(error => {
        initPromise = null
        throw error
      })
  }
  return initPromise
}
