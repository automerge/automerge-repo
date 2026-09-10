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

/** `DocHandle[kOnInternal](event, fn)` / `HandleRegistry[kOnInternal](...)` -
 * attach a repo-internal listener (stored like any other listener, but not
 * an external retainer of the document; see `kRetainDocument`). */
export const kOnInternal = Symbol("automerge-repo.onInternal")

/** `Document[kRetainDocument]()` (and the `DocHandle` passthrough) - count
 * one external retainer on the document. */
export const kRetainDocument = Symbol("automerge-repo.retainDocument")

/** `Document[kReleaseDocument]()` (and the `DocHandle` passthrough) -
 * balance `kRetainDocument`. */
export const kReleaseDocument = Symbol("automerge-repo.releaseDocument")

/** `Document[kSeverRetention]()` (and the `DocHandle` passthrough) -
 * explicit-teardown hook for `Repo.delete` / `removeFromCache`: drop all
 * external retention and prevent re-rooting. */
export const kSeverRetention = Symbol("automerge-repo.severRetention")

/** `Document[kOnRetainChange]` - callback field assigned by `Repo`, fired on
 * the retention refcount's 0-to-1 and 1-to-0 transitions. */
export const kOnRetainChange = Symbol("automerge-repo.onRetainChange")

/** Set on a `once()` wrapper to name the original listener, so
 * `off(event, fn)` can remove the wrapper by the function the caller
 * actually passed (and release its retention). */
export const kOnceOriginal = Symbol("automerge-repo.onceOriginal")

/** `DocumentQuery[kSubscribeInternal](cb)` - subscribe without externally
 * retaining the document (repo-internal observers only). */
export const kSubscribeInternal = Symbol("automerge-repo.subscribeInternal")
