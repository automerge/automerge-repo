import type { DocHandle } from "../DocHandle.js"
import type { Repo } from "../Repo.js"
import { encodeHeads } from "../AutomergeUrl.js"
import type { Heads } from "@automerge/automerge/slim"
import type {
  Pattern,
  CursorMarker,
  RefUrl,
  SegmentsFromString,
  Ref,
  InferRefTypeFromString,
} from "./types.js"
import { CURSOR_MARKER } from "./types.js"
import { RefImpl } from "./ref.js"
import { parseRefUrl } from "./parser.js"

/**
 * Create a cursor-based range segment for stable text selection.
 *
 * Must be used as the last argument in a ref path.
 * Creates stable cursors that track text positions through edits.
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @example
 * ```ts
 * handle.ref('note', cursor(0, 5))  // Cursor-based range on text
 * ```
 */
export function cursor(start: number, end?: number): CursorMarker {
  return { [CURSOR_MARKER]: true, start, end: end ?? start }
}

/**
 * Parse a ref from a URL string.
 *
 * The URL's documentId must match the provided handle's documentId.
 * Use `findRef` instead if you don't have the handle and need to look it up.
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @typeParam TValue - The expected type of the value this ref points to (defaults to unknown)
 *
 * @param handle - The document handle to use (must match URL's documentId)
 * @param url - Full ref URL like "automerge:documentId/path#heads"
 * @throws Error if URL's documentId doesn't match handle's documentId
 *
 * @example
 * ```ts
 * const ref = refFromUrl<string>(handle, "automerge:abc/todos/0/title" as RefUrl);
 * ref.value(); // string | undefined
 * ```
 */
export function refFromUrl<TValue = unknown>(
  handle: DocHandle<any>,
  url: RefUrl
): Ref<TValue> {
  const { documentId, segments, heads } = parseRefUrl(url)

  if (documentId !== handle.documentId) {
    throw new Error(
      `URL documentId "${documentId}" does not match handle's documentId "${handle.documentId}"`
    )
  }

  // If URL has heads, get a time-traveled handle
  const targetHandle = heads
    ? handle.view(encodeHeads(heads as Heads))
    : handle

  return new RefImpl(targetHandle, segments) as Ref<TValue>
}

/**
 * Create a ref from a path string.
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @example
 * ```ts
 * type Doc = { todos: Array<{ title: string }> };
 * const titleRef = refFromString(handle, "todos/0/title");
 * titleRef.value(); // string | undefined
 * ```
 */
export function refFromString<TDoc, TPath extends string>(
  docHandle: DocHandle<TDoc>,
  path: TPath
): Ref<InferRefTypeFromString<TDoc, TPath>> {
  const url = docHandle.url
  const { segments } = parseRefUrl(`${url}/${path}` as RefUrl)
  return new RefImpl(
    docHandle,
    segments as unknown as [...SegmentsFromString<TPath>]
  ) as Ref<InferRefTypeFromString<TDoc, TPath>>
}

/**
 * Find a ref by its URL.
 *
 * URL format: `automerge:{documentId}/{path}#{heads}`
 *
 * @experimental This API is experimental and may change in future versions.
 *
 * @typeParam TValue - The expected type of the value this ref points to (defaults to unknown)
 *
 * @example
 * ```ts
 * const ref = await findRef<string>(repo, "automerge:abc123/todos/0/title" as RefUrl);
 * ref.value(); // string | undefined
 * ```
 */
export async function findRef<TValue = unknown>(
  repo: Repo,
  url: RefUrl
): Promise<Ref<TValue>> {
  const { documentId } = parseRefUrl(url)
  const handle = await repo.find(documentId as any)
  await handle.whenReady()

  return refFromUrl<TValue>(handle, url)
}

/**
 * Check if an item matches a pattern.
 *
 * Note: This performs shallow equality checks only. Nested objects
 * are compared by reference, not by deep value equality.
 *
 * @internal
 */
export function matchesPattern(item: any, pattern: Pattern): boolean {
  return Object.entries(pattern).every(([key, value]) => item[key] === value)
}
