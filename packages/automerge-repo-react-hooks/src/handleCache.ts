import {
  AnyDocType,
  AnyDocumentId,
  AutomergeUrl,
  DocHandle,
  Repo,
  interpretAsDocumentId,
  parseAutomergeUrl,
  parseDocumentUrl,
  parseUrlScheme,
  stringifyAutomergeUrl,
  stringifyDocumentUrl,
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

type CacheDocType = Pick<AnyDocType, "scheme" | "openUrl">

function formatUrl(
  id: string,
  urlScheme: string,
  docType?: CacheDocType
): string {
  if (urlScheme === "automerge") {
    try {
      const { documentId, heads, segments } = parseAutomergeUrl(
        id as AutomergeUrl
      )
      return stringifyAutomergeUrl({ documentId, heads, segments })
    } catch {
      return id
    }
  }
  if (!docType?.openUrl) {
    try {
      return stringifyDocumentUrl(parseDocumentUrl(id))
    } catch {
      return id
    }
  }
  return id
}

/** `id` as a canonical URL where possible (e.g. a long ID's short form, or
 * sorted heads on an Automerge URL). A bare document ID uses `docType`'s
 * scheme (`automerge` by default). Custom doc-type URLs are kept as given. */
export function normalizeId(id: AnyDocumentId, docType?: CacheDocType): string {
  const scheme = docType?.scheme ?? "automerge"
  const urlScheme = parseUrlScheme(id)
  if (urlScheme === undefined)
    return stringifyDocumentUrl({
      documentId: interpretAsDocumentId(id),
      scheme,
    })
  return formatUrl(id as string, urlScheme, docType)
}

/** The cache key for `id` opened as `docType` (Automerge by default): one
 * entry per document, however it is written. An invalid `id` is its own key;
 * `find()` then rejects it, as it does a URL of another doc type. */
export function cacheKey(id: AnyDocumentId, docType?: CacheDocType): string {
  const scheme = docType?.scheme ?? "automerge"
  try {
    const urlScheme = parseUrlScheme(id)
    if (urlScheme === undefined)
      return stringifyDocumentUrl({
        documentId: interpretAsDocumentId(id),
        scheme,
      })
    const url = formatUrl(id as string, urlScheme, docType)
    return urlScheme !== scheme ? `${url} as ${scheme}` : url
  } catch {
    return scheme === "automerge" ? String(id) : `${String(id)} as ${scheme}`
  }
}
