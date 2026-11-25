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

/** `id` as the URL its handle has (e.g. a long ID's short form). A bare
 * document ID is taken to be of the doc type named `docTypeName`. */
export function normalizeId(
  id: AnyDocumentId,
  docTypeName = "automerge"
): string {
  if (!isValidAutomergeUrl(id))
    return stringifyAutomergeUrl({
      documentId: interpretAsDocumentId(id),
      docType: { name: docTypeName },
    })
  const parsed = parseAutomergeUrl(id)
  return stringifyAutomergeUrl({
    ...parsed,
    docType: { name: parsed.docTypeName },
  })
}

/** The cache key for `id` opened as the doc type named `docTypeName`: one
 * entry per document, however it is written. An invalid `id` is its own
 * key; `find()` then rejects it, as it does a URL of another doc type. */
export function cacheKey(id: AnyDocumentId, docTypeName = "automerge"): string {
  try {
    const url = normalizeId(id, docTypeName)
    return isValidAutomergeUrl(id) &&
      parseAutomergeUrl(id).docTypeName !== docTypeName
      ? `${url} as ${docTypeName}`
      : url
  } catch {
    return docTypeName === "automerge"
      ? String(id)
      : `${String(id)} as ${docTypeName}`
  }
}
