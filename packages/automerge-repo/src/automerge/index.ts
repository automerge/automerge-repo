export { automerge } from "./docType.js"
export type { AutomergeDocType, AutomergeKind } from "./docType.js"

export type {
  DocHandleChangePayload,
  DocHandleDeletePayload,
  DocHandleEncodedChangePayload,
  DocHandleHeadsChangedPayload,
  DocHandleRemoteHeadsPayload,
  DocHandleEvents,
} from "./events.js"

export {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  generateAutomergeUrl,
} from "./url.js"
export type { AutomergeUrl, ParsedAutomergeUrl, UrlOptions } from "./url.js"

// Sub-document handle helpers (experimental). A sub-handle is just a
// `DocHandle` scoped to a path - `handle.sub(...)` returns a `DocHandle`.
// Path-related types and the `cursor()` helper live here.
export type {
  PathInput,
  MutableText,
  InferSubType,
  Pattern,
  SubChangeFn,
} from "./subdoc-handles/types.js"
export { cursor } from "./subdoc-handles/utils.js"

export * from "./reexports.js"
