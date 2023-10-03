/**
 * @packageDocumentation
 *
 * The [`automerge`](https://www.npmjs.com/package/@automerge/automerge) CRDT
 * provides a core CRDT data structure and an implementation of a storage
 * format and sync protocol but doesn't provide the plumbing to use these tools
 * in a JS application. `automerge-repo` provides the plumbing.
 *
 * The main entry point is the {@link Repo} class, which you instantiate with
 * a {@link StorageAdapter} and zero or more {@link NetworkAdapter}s. Once you
 * have a repo you can use it to create {@link DocHandle}s. {@link DocHandle}s
 * are a reference to a document, identified by a {@link AutomergeUrl}, a place to
 * listen for changes to the document, and to make new changes.
 *
 * A typical example of how to use this library then might look like this:
 *
 * ```typescript
 * import { Repo } from "@automerge/automerge-repo";
 *
 * const repo = new Repo({
 *   storage: <storage adapter>,
 *   network: [<network adapter>, <network adapter>]
 * })
 *
 * const handle = repo.create
 * ```
 */

export {
  DocHandle,
  type HandleState,
  type DocHandleOptions,
  type DocHandleEvents,
} from "./DocHandle.js"
export type {
  DocHandleChangePayload,
  DocHandleDeletePayload,
  DocHandleEphemeralMessagePayload,
  DocHandleOutboundEphemeralMessagePayload,
  DocHandleEncodedChangePayload,
} from "./DocHandle.js"
export { NetworkAdapter } from "./network/NetworkAdapter.js"
export type {
  OpenPayload,
  PeerCandidatePayload,
  PeerDisconnectedPayload,
  NetworkAdapterEvents,
} from "./network/NetworkAdapter.js"

export type {
  RepoMessage as Message,
  ArriveMessage,
  WelcomeMessage,
  Message as NetworkAdapterMessage,
  EphemeralMessage,
  RequestMessage,
  DocumentUnavailableMessage,
  SyncMessage,
} from "./network/messages.js"
export { isValidMessage } from "./network/messages.js"

export {
  Repo,
  type SharePolicy,
  type RepoConfig,
  type RepoEvents,
  type DeleteDocumentPayload,
  type DocumentPayload,
} from "./Repo.js"
export { StorageAdapter, type StorageKey } from "./storage/StorageAdapter.js"
export {
  parseAutomergeUrl,
  isValidAutomergeUrl,
  stringifyAutomergeUrl as generateAutomergeUrl,
} from "./DocUrl.js"
export * from "./types.js"

/** @hidden **/
export * as cbor from "./helpers/cbor.js"
