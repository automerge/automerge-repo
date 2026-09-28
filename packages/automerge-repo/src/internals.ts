/**
 * Cross-class internal wiring for the automerge-repo package.
 *
 * `#`-private members cannot cross class boundaries, so this "protected
 * between classes" tier uses unique symbols. The module is not re-exported
 * from index.ts and the package's `exports` map does not expose it, so
 * consumers cannot obtain the symbols (each is a unique `Symbol()`, so the
 * description string grants no access either).
 *
 * @internal
 */

/** Set on a `once()` wrapper to name the original listener, so
 * `off(event, fn)` can remove the wrapper by the function the caller
 * actually passed. */
export const kOnceOriginal = Symbol("automerge-repo.onceOriginal")
