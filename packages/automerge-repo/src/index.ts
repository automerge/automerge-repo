/**
 * @packageDocumentation
 *
 * The [`automerge`](https://www.npmjs.com/package/@automerge/automerge) CRDT
 * provides a core CRDT data structure and an implementation of a storage
 * format and sync protocol but doesn't provide the plumbing to use these tools
 * in a JS application. `automerge-repo` provides the plumbing.
 *
 * The main entry point is the {@link Repo} class, with a sedimentree backend
 * for storage and synchronization ({@link MemoryBackend} by default). Once you
 * have a repo you can use it to create {@link DocHandle}s. {@link DocHandle}s
 * are a reference to a document, identified by a {@link AutomergeUrl}, a place to
 * listen for changes to the document, and to make new changes.
 *
 * A typical example of how to use this library then might look like this:
 *
 * ```typescript
 * import { Repo } from "@automerge/automerge-repo";
 *
 * const repo = new Repo()
 *
 * const handle = await repo.create({ count: 0 })
 * await handle.change(doc => { doc.count++ })
 * ```
 */

export { DocHandle } from "./types/DocHandle.js"
/** @hidden The class's own type; use {@link DocHandle}. Exported so other
 * packages' declarations can name handle types. */
export type { Handle as DocHandleClass } from "./Handle.js"
/** What a backend's extensions add to handles: the `X` of `Repo<X>` and
 * `DocHandle<T, X>`. Extensions are written and listed with the
 * `@automerge/automerge-repo/sedimentree` entry. */
export type { HandleExtensionSpec } from "./sedimentree/extension.js"
export {
  isValidDocumentUrl,
  isValidUrlScheme,
  isValidDocumentId,
  parseDocumentUrl,
  parseUrlScheme,
  stringifyDocumentUrl,
  interpretAsDocumentId,
  documentIdToBinary,
  binaryToDocumentId,
  encodeHeads,
  decodeHeads,
} from "./DocumentUrl.js"
export type {
  DocumentUrlOptions,
  ParsedDocumentUrl,
  UrlDocType,
} from "./DocumentUrl.js"
export { Repo } from "./Repo.js"
export { setLoggerFactory, makeLogger } from "./Logger.js"
export type { Logger, LoggerFactory } from "./Logger.js"
export { Presence } from "./presence/Presence.js"
export {
  PeerStateView,
  originIdentity,
  senderIdentity,
} from "./presence/PeerStateView.js"
export type { GetStatesOpts } from "./presence/PeerStateView.js"
export type {
  PeerState,
  PresenceState,
  PresenceConfig,
  PresenceHandle,
  PresenceInbound,
  PeerStatesValue,
  PresenceEvents,
  PresenceEventUpdate,
  PresenceEventSnapshot,
  PresenceEventHeartbeat,
  PresenceEventGoodbye,
  PresenceEventPruning,
} from "./presence/types.js"
// Type-only re-export so the {@link DEFAULT_*} references in PresenceConfig
// resolve in typedoc, without exposing the consts to the runtime API.
export type {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PEER_TTL_MS,
} from "./presence/constants.js"

/** @hidden **/
export * as cbor from "./helpers/cbor.js"

// types

export type {
  AbortOptions,
  DeleteDocumentPayload,
  DocumentPayload,
  HandleOf,
  RepoConfig,
  RepoEvents,
  RepoFindOptions,
} from "./Repo.js"
export type { MintDocumentId } from "./sedimentree/backend.js"
export { MemoryBackend } from "./sedimentree/memory/MemoryBackend.js"
export type { MemoryBackendOptions } from "./sedimentree/memory/MemoryBackend.js"

export type { DocumentQuery, QueryState } from "./DocumentQuery.js"
export type {
  DocumentProgress,
  ProgressState,
  SourceState,
} from "./DocumentProgress.js"

export { isHandleOf } from "./types/DocHandle.js"
export type { AnyDocHandle, AnyHandleKind } from "./types/DocHandle.js"
export { Handle } from "./Handle.js"
export type { StateChange } from "./Handle.js"
export { defineDocType } from "./DocType.js"
export type {
  AnyDocType,
  DocType,
  DocTypeContext,
  HandleKind,
  InitOf,
  KindOf,
  Of,
  SchemeOf,
  Shaped,
  UrlTarget,
} from "./DocType.js"
// Internal doc-type plumbing, re-exported for TypeScript declaration portability.
export type {
  DocTypeHelpers,
  HandleOfClass,
  Kinded,
  PlainHandle,
} from "./docTypeKinds.js"
export type { BackendOf, SameBackend, WithBackend } from "./types/DocHandle.js"

export * from "./types.js"

// Automerge doc type: doc type definition, events, URLs, sub-document handles
// and Automerge CRDT re-exports.
export * from "./automerge/index.js"
