let initialized = false

/**
 * Initialize the Subduction Wasm module. Must be called before
 * constructing a Repo. Safe to call multiple times (idempotent).
 *
 * This performs a dynamic import of `@automerge/automerge-subduction`
 * (the non-`/slim` entry), which auto-initializes the Wasm module as
 * a side effect. The `/slim` entry used internally by the Repo shares
 * the same module-scoped Wasm instance, so it sees the initialized
 * module without needing its own init step.
 */
export async function initSubduction(): Promise<void> {
  if (initialized) return
  await import("@automerge/automerge-subduction")
  initialized = true
}
