import { DocHandle } from "@automerge/automerge-repo";
import { Ref } from "./ref.js";
import type { PathInput } from "./types.js";

/**
 * Cache for ref instances, keyed by document handle and path.
 * Uses WeakMap so refs can be garbage collected when the handle is no longer referenced.
 *
 * We store the cache in the globalThis object so multiple library instances can share the same cache.
 */
let refCache = (globalThis as any).__automerge_ref_cache__;
if (!refCache) {
  refCache = new WeakMap<DocHandle<any>, Map<string, WeakRef<Ref<any>>>>();
  (globalThis as any).__automerge_ref_cache__ = refCache;
}

/**
 * Create a stable cache key from path segments.
 * Serializes the path to a string for comparison.
 */
// TODO: this *could* use ref.url but we need to resolve some encoding scheme questions first
function pathToCacheKey(segments: readonly PathInput[]): string {
  return segments
    .map((seg) => {
      if (typeof seg === "string") return `s:${seg}`;
      if (typeof seg === "number") return `n:${seg}`;
      if (typeof seg === "object" && seg !== null) {
        // Pattern or CursorMarker
        return `o:${JSON.stringify(seg)}`;
      }
      return `?:${String(seg)}`;
    })
    .join("/");
}

/**
 * Create a ref with automatic type inference.
 *
 * Returns the same ref instance for the same document and path.
 * This ensures referential equality when creating refs to the same location.
 *
 * @example
 * ```ts
 * const titleRef = ref(handle, 'todos', 0, 'title');
 * titleRef.value(); // string | undefined
 *
 * // Same ref instance is returned for same path
 * const sameRef = ref(handle, 'todos', 0, 'title');
 * titleRef === sameRef; // true
 * ```
 */
export function ref<TDoc, TPath extends readonly PathInput[]>(
  docHandle: DocHandle<TDoc>,
  ...segments: [...TPath]
): Ref<TDoc, TPath> {
  // Get or create cache for this document handle
  let handleCache = refCache.get(docHandle);
  if (!handleCache) {
    handleCache = new Map();
    refCache.set(docHandle, handleCache);
  }

  // Check if we have a cached ref for this path
  const cacheKey = pathToCacheKey(segments);
  const existingRef = handleCache.get(cacheKey)?.deref();

  if (existingRef) {
    return existingRef as Ref<TDoc, TPath>;
  }

  // Create new ref and cache it
  const newRef = new Ref<TDoc, TPath>(docHandle, segments as [...TPath]);
  handleCache.set(cacheKey, new WeakRef(newRef));

  return newRef;
}
