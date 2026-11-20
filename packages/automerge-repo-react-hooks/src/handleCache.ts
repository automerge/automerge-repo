import {
  AnyDocumentId,
  DocHandle,
  Repo,
  isValidAutomergeUrl,
  interpretAsDocumentId,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "@automerge/automerge-repo/slim"
import type { PromiseWrapper } from "./wrapPromise.js"

type HandleCache = Map<string, PromiseWrapper<DocHandle<unknown>>>

const caches = new WeakMap<Repo, HandleCache>()

/** Pending and settled `find()` lookups made by the hooks on `repo`. */
export function handleCache(repo: Repo): HandleCache {
  let cache = caches.get(repo)
  if (!cache) {
    cache = new Map()
    caches.set(repo, cache)
  }
  return cache
}

/** `id` as the URL its handle has (e.g. a long ID's short form). */
export function normalizeId(id: AnyDocumentId): string {
  return stringifyAutomergeUrl(
    isValidAutomergeUrl(id)
      ? parseAutomergeUrl(id)
      : { documentId: interpretAsDocumentId(id) }
  )
}

/** The cache key for `id`: one entry per document, however it is written.
 * An invalid `id` is its own key; `find()` then rejects it. */
export function cacheKey(id: AnyDocumentId): string {
  try {
    return normalizeId(id)
  } catch {
    return String(id)
  }
}
