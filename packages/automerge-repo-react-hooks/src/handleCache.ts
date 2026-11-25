import {
  AnyDocumentId,
  AutomergeUrl,
  DocHandle,
  Repo,
  interpretAsDocumentId,
  parseAutomergeUrl,
  parseDocumentUrl,
  stringifyAutomergeUrl,
  stringifyDocumentUrl,
  type ParsedDocumentUrl,
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

function tryParseUrl(id: AnyDocumentId): ParsedDocumentUrl | undefined {
  if (typeof id !== "string" || !id) return undefined
  try {
    return parseDocumentUrl(id)
  } catch {
    return undefined
  }
}

function formatParsed(id: string, parsed: ParsedDocumentUrl): string {
  if (parsed.scheme === "automerge" && parsed.suffix !== undefined) {
    try {
      const { documentId, heads, segments } = parseAutomergeUrl(
        id as AutomergeUrl
      )
      return stringifyAutomergeUrl({ documentId, heads, segments })
    } catch {
      // Invalid Automerge suffix; preserve raw URL so `find()` rejects it.
    }
  }
  return stringifyDocumentUrl(parsed)
}

/** `id` as the URL its handle has (e.g. a long ID's short form). A bare
 * document ID is taken to be of the doc type with `scheme`. */
export function normalizeId(id: AnyDocumentId, scheme = "automerge"): string {
  const parsed = tryParseUrl(id)
  if (!parsed)
    return stringifyDocumentUrl({
      documentId: interpretAsDocumentId(id),
      scheme,
    })
  return formatParsed(id as string, parsed)
}

/** The cache key for `id` opened as the doc type with `scheme`: one entry per
 * document, however it is written. An invalid `id` is its own key; `find()`
 * then rejects it, as it does a URL of another doc type. */
export function cacheKey(id: AnyDocumentId, scheme = "automerge"): string {
  try {
    const parsed = tryParseUrl(id)
    if (!parsed)
      return stringifyDocumentUrl({
        documentId: interpretAsDocumentId(id),
        scheme,
      })
    const url = formatParsed(id as string, parsed)
    return parsed.scheme !== scheme ? `${url} as ${scheme}` : url
  } catch {
    return scheme === "automerge" ? String(id) : `${String(id)} as ${scheme}`
  }
}
