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
  isValidDocumentId,
  parseAutomergeUrl,
  stringifyAutomergeUrl,
  interpretAsDocumentId,
  generateAutomergeUrl,
  encodeHeads,
  decodeHeads,
} from "./AutomergeUrl.js"
export { Repo } from "./Repo.js"
export { NetworkAdapter } from "./network/NetworkAdapter.js"
export type { NetworkAdapterInterface } from "./network/NetworkAdapterInterface.js"
export { isRepoMessage } from "./network/messages.js"
export { StorageAdapter } from "./storage/StorageAdapter.js"
export type { StorageAdapterInterface } from "./storage/StorageAdapterInterface.js"
import { next as Automerge, type ObjID } from "@automerge/automerge/slim"

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
  SyncInfo,
} from "./DocHandle.js"

export type {
  DeleteDocumentPayload,
  DocumentPayload,
  RepoConfig,
  RepoEvents,
  SharePolicy,
} from "./Repo.js"

export type {
  NetworkAdapterEvents,
  OpenPayload,
  PeerCandidatePayload,
  PeerDisconnectedPayload,
  PeerMetadata,
} from "./network/NetworkAdapterInterface.js"

export type {
  NetworkSubsystemEvents,
  PeerPayload,
} from "./network/NetworkSubsystem.js"

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

// Automerge re-exports
//
// Note that we can't use export type { .. } from "@automerge/automerge" because we are
// importing automerge like this:
//
// import { next as Automerge } from "@automerge/automerge"
//
// I.e. we are using the `next` export from Automerge. Not the module itself. This is
// to maintain compatiblity with Automerge 3.0 and 2.0. In 2.0 we used to have a
// subpath export at `/next` so the re-exports looked like this:
//
// export { type .. } from "@automerge/automerge/slim/next"
//
// However, we have now removed the subpath export (and deprecated next generally)
// so we need to explicitly name each type we are re-exporting here.
export const Counter = Automerge.Counter
export const RawString = Automerge.RawString
// In automerge 3.0 RawString is renamed to ImmutableString
export const ImmutableString = Automerge.RawString

// Export separate RawString and ImmutableString types,
// whose symbols are only usable as values otherwise.
export type RawString = InstanceType<typeof Automerge.RawString>
export type ImmutableString = RawString

export type Counter = Automerge.Counter
export type Doc<T> = Automerge.Doc<T>
export type Heads = Automerge.Heads
export type Patch = Automerge.Patch
export type PatchCallback<T> = Automerge.PatchCallback<T>
export type Prop = Automerge.Prop
export type ActorId = Automerge.ActorId
export type Change = Automerge.Change
export type ChangeFn<T> = Automerge.ChangeFn<T>
export type Mark = Automerge.Mark
export type MarkSet = Automerge.MarkSet
export type MarkRange = Automerge.MarkRange
export type MarkValue = Automerge.MarkValue
export type Cursor = Automerge.Cursor

// export a few utility functions that aren't in automerge-repo
// NB that these should probably all just be available via the dochandle
export const getChanges = Automerge.getChanges
export const getAllChanges = Automerge.getAllChanges
export const applyChanges = Automerge.applyChanges
export const view = Automerge.view
export const getConflicts = Automerge.getConflicts

// export type-specific utility functions
// these mostly can't be on the data-type in question because
// JS strings can't have methods added to them
export const getCursor = Automerge.getCursor
export const getCursorPosition = Automerge.getCursorPosition
export const splice = Automerge.splice
export const updateText = Automerge.updateText
export const insertAt = Automerge.insertAt
export const deleteAt = Automerge.deleteAt
export const mark = Automerge.mark
export const unmark = Automerge.unmark
export const isRawString = Automerge.isRawString
// In Automerge 3.0 raw string is renamed to immutable string
export const isImmutableString = Automerge.isRawString

export const getObjectId = Automerge.getObjectId
export type { ObjID }
