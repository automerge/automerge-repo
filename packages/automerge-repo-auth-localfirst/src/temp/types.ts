import { DocumentId, PeerId } from "@automerge/automerge-repo"

// TRANSFORMATION

/** A Transform consists of two functions, for transforming inbound and outbound messages, respectively. */
export type Transform = {
  inbound: MessageTransformer
  outbound: MessageTransformer
}

export type MessageTransformer = (msg: any) => any

// AUTHORIZATION

/**
 * A SharePolicy takes a peer ID and optionally a document ID and returns true if the peer is
 * authorized to access the document.
 */
export type SharePolicy = (
  peerId: PeerId,
  documentId?: DocumentId
) => Promise<boolean>
