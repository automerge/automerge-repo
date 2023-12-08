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

export { DocHandle } from "./DocHandle.js"
export {
  isValidAutomergeUrl,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
} from "./AutomergeUrl.js"
export { Repo } from "./Repo.js"
export { NetworkAdapter } from "./network/NetworkAdapter.js"
export { isRepoMessage } from "./network/messages.js"
export { StorageAdapter } from "./storage/StorageAdapter.js"

/** @hidden **/
export * as cbor from "./helpers/cbor.js"

// types

export type {
  DocHandleChangePayload,
  DocHandleDeletePayload,
  DocHandleEncodedChangePayload,
  DocHandleEphemeralMessagePayload,
  DocHandleRemoteHeadsPayload,
  DocHandleEvents,
  DocHandleOptions,
  DocHandleOutboundEphemeralMessagePayload,
  HandleState,
} from "./DocHandle.js"

export type {
  NetworkAdapterEvents,
  OpenPayload,
  PeerCandidatePayload,
  PeerDisconnectedPayload,
  PeerMetadata,
} from "./network/NetworkAdapter.js"

export type {
  DocumentUnavailableMessage,
  EphemeralMessage,
  Message,
  RepoMessage,
  RequestMessage,
  SyncMessage,
} from "./network/messages.js"

export type {
  Chunk,
  ChunkInfo,
  ChunkType,
  StorageKey,
  StorageId,
} from "./storage/types.js"

export * from "./types.js"
