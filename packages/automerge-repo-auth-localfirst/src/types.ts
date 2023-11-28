import {
  DocumentId,
  Message,
  PeerId,
  StorageAdapter,
} from "@automerge/automerge-repo"

import * as Auth from "@localfirst/auth"

/** The team's ID is used as the ID for a share */
export type ShareId = Auth.Hash & { __shareId: true }

export type Config = {
  /** We always have the local device's info and keys */
  device: Auth.DeviceWithSecrets

  /** We have our user info, unless we're a new device using an invitation */
  user?: Auth.UserWithSecrets

  /** We need to be given some way to persist our state */
  storage: StorageAdapter
}

export type LocalFirstAuthMessagePayload = {
  shareId: ShareId
  serializedConnectionMessage: Uint8Array
}

export type LocalFirstAuthMessage = AuthMessage<LocalFirstAuthMessagePayload>

export type EncryptedMessage = {
  type: "encrypted"
  senderId: PeerId
  targetId: PeerId
  shareId: ShareId
  encryptedMessage: Auth.Base58
}

export const isEncryptedMessage = (
  message: Message | EncryptedMessage
): message is EncryptedMessage => message.type === "encrypted"

/**
 * A share is a set of document IDs that are shared with one or more users. The group is represented by a
 * localfirst/auth `Team` instance.
 */
export type Share = {
  shareId: ShareId
  team: Auth.Team

  /** If no document IDs are specified, then all documents are assumed to be shared */
  documentIds?: Set<DocumentId>
}

/** To save our state, we serialize each share */
export type SerializedShare = {
  shareId: ShareId
  encryptedTeam: Uint8Array
  encryptedTeamKeys: Uint8Array
  documentIds: DocumentId[]
}

export type SerializedState = Record<ShareId, SerializedShare>

export type DeviceInvitation = {
  shareId: ShareId
  userName: string
  userId: string
  invitationSeed: string
}

export type MemberInvitation = {
  shareId: ShareId
  invitationSeed: string
}

export type Invitation = DeviceInvitation | MemberInvitation

export const isDeviceInvitation = (
  invitation: Invitation
): invitation is DeviceInvitation => {
  return "userName" in invitation && "userId" in invitation
}

export type ErrorPayload = Auth.ConnectionErrorPayload & {
  shareId: ShareId
  peerId: PeerId
}

export interface LocalFirstAuthProviderEvents {
  /** We've loaded any persisted state so for example you can ask for a team */
  ready: () => void

  /**
   * We've successfully joined a team using an invitation. This event provides the team graph and
   * the user's info (including keys). (When we're joining as a new device for an existing user,
   * this is how we get the user's keys.) This event gives the application a chance to persist the
   * team graph and the user's info.
   */
  joined: (payload: {
    shareId: ShareId
    peerId: PeerId
    team: Auth.Team
    user: Auth.User
  }) => void

  /**
   * We're connected to a peer and have been mutually authenticated.
   */
  connected: (payload: { shareId: ShareId; peerId: PeerId }) => void

  /**
   * We've detected an error locally, e.g. a peer tries to join with an invalid invitation.
   */
  localError: (payload: ErrorPayload) => void

  /**
   * Our peer has detected an error and reported it to us, e.g. we tried to join with an invalid
   * invitation.
   */
  remoteError: (payload: ErrorPayload) => void

  /**
   * The auth connection disconnects from a peer after entering an error state.
   */
  disconnected: (payload: {
    shareId: ShareId
    peerId: PeerId
    event: Auth.ConnectionMessage
  }) => void
}

/** Sent by an {@link AuthProvider} to authenticate a peer */
export type AuthMessage<TPayload = any> = {
  type: "auth"

  /** The peer ID of the sender of this message */
  senderId: PeerId

  /** The peer ID of the recipient of this message */
  targetId: PeerId

  /** The payload of the auth message (up to the specific auth provider) */
  payload: TPayload
}

export const isAuthMessage = (msg: any): msg is AuthMessage =>
  msg.type === "auth"

// TRANSFORMATION

/** A Transform consists of two functions, for transforming inbound and outbound messages, respectively. */
export type Transform = {
  inbound: MessageTransformer
  outbound: MessageTransformer
}

export type MessageTransformer = (msg: any) => any
