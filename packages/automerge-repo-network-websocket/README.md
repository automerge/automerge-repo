# Automerge-Repo Network: Websocket

Includes two implementations, a Websocket client and a Websocket server. These are used by the example sync-server.

The package uses isomorphic-ws to share code between node and the browser, but the server code is node only due to lack of browser support.

## Wire Protocol

### Peer naming

Whilst currently this wire protocol is only used for the websocket, it is
probably generically useful for any stream oriented transport (e.g. TCP or
QUIC). To make translating this spec to other transports easier we refer to the
two parties in the protocol as the "initiating" and "receiving" peers. In the
WebSocket case the "initiating" peer is the client and the "receiving" peer
is the server.

### Overview

The websocket wire protocol consists of a handshake where each peer tells the other what their peer ID - and some other metadata - is followed by the sync loop where each peer can send the other sync messages and ephemeral messages.

### Handshake

Before sync can continue each peer needs to exchange peer IDs and agree on the
protocol version they are using (although currently there is only one version).
Handshake is the following steps:

- Once a connection is established the initiating peer sends a
  [join](#join) message with the `senderId` set to the initiating peers ID and
  the `protocolVersion` set to "1"
- The receiving peer waits until it receives a message from the initiating
  peer, if the initiating peer receives a message before sending the join message
  the initiating peer SHOULD terminate the connection.
- When the receiving peer receives the join message
  - if the `protocolVersion` is not "1" the receiving peer sends an
    [error](#error) message and terminates the connection
  - otherwise
    - store the `senderId` as the peer ID of the initiating peer
    - emit a "peer-candidate" event with the sender ID as the peer
    - respond with a [peer](#peer) message with the `targetId` set to the
      initiating peers peer ID, the `senderId` set to the receiving peers
      peer ID and the `selectedProtocolVersion` set to "1"
    - begin the sync phase
- Once the initiating peer has sent the join message it waits for a peer message
  in response. If it receives any other message type before the join message
  the receiving peer should send an [error](#error) message and terminates the
  connection
- When the initiating peer receives the peer message
  - it stores the `senderId` as the peer ID of the receiving peer.
  - it emits a "peer-candidate" event with the sender ID as the peer
  - if the `selectedProtocolVersion` is anything other than "1" the initiating
    peer sends an [error](#error) message and terminates the connection
  - it begins the sync phase

#### Peer IDs and storage IDs

The peer ID is an ephemeral ID which is assumed to only live for the lifetime of the process which advertises the given ID (e.g. a browser tab). Peers may optionally advertise a storage ID in the `join` and `peer` messages, this is an ID which is assumed to be tied to a persistent storage of some kind (e.g. an IndexedDB in a browser). Many peer IDs can advertise the same storage ID (as in the case of many browser tabs). The use of a storage ID allows other peers to know whether to save and reload sync states for a given peer (if the peer advertises a storage ID, then save and reload the sync state attached to that storage ID).

### Sync Phase

In the sync phase either side may send a [request](#request), [sync](#sync),
[unavailable](#unavailable), or [ephemeral](#ephemeral) message. Sending these
corresponds to implementing
[`NetworkAdapter.send`](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.NetworkAdapter.html#send)
and receiving is emitting the [corresponding
event](https://automerge.org/automerge-repo/interfaces/_automerge_automerge_repo.NetworkAdapterEvents.html)
from the `NetworkAdapter` on receipt.

#### Remote heads gossiping

In some cases peers wish to know about the state of peers who are separated from them by several intermediate peers. For example, a tab running a text editor may wish to show whether the contents of the editor are up to date with respect to a tab running in a browser on another users device. This is achieved by gossiping remote heads across intermediate nodes. The logic for this is the following:

- For a given connection each peer maintains a list of the storage IDs the remote peer is interested in (note this is storage IDs, not peer IDs)
- Any peer can send a [`remote-subscription-changed`](#remote-subscription-changed) message to change the set of storage IDs they want the recipient to watch on the sender's behalf
- Any time a peer receives a sync message it checks:
  - Is the sync message from a peer with a storage ID which some other remote peer has registered interest in
  - Is the remote peer permitted access to the document which the message pertains to (i.e. either the `sharePolicy` return `true` or the local peer is already syncing the document with the remote)
- The local peer sends a [`remote-heads-changed`](#remote-heads-changed) message to each remote peer who passes these checks
- Additionally, whenever the local peer receives a `remote-heads-changed` message it performs the same checks and additionally checks if the timestamp on the `remote-heads-changed` message is greater than the last timestamp for the same storage ID/document combination and if so it forwards it.

In the `browser <-> sync server <-> browser` text editor example above each browser tab would send a `remote-subscription-changed` message to the sync server adding the other browsers storage ID (presumably communicated out of band) to their subscriptions with the sync server. The sync server will then send `remote-heads-changed` messages to each tab when their heads change.

In a more elaborate example such as `browser <-> sync server <-> sync server <-> browser` the intermediate sync servers could be configured to have their `sharePolicy` return `true` for every document when syncing with each other so that `remote-heads-changed` messages are forwarded between them unconditionally, allowing the browser tabs to still learn of each others heads.

### Message Types

All messages are encoded using CBOR and are described in this document using
[cddl](https://datatracker.ietf.org/doc/html/rfc8610)

#### Preamble

These type definitions are used in every message type

```cddl
; The base64 encoded bytes of a Peer ID
peer_id = str
; The base64 encoded bytes of a Storage ID
storage_id = str
; The possible protocol versions (currently always the string "1")
protocol_version = "1"
; The bytes of an automerge sync message
sync_message = bstr
; The base58check encoded bytes of a document ID
document_id = str
; Metadata sent in either the join or peer message types
peer_metadata = {
    ; The storage ID of this peer
    ? storageId: storage_id,
    ; Whether the sender expects to connect again with this storage ID
    isEphemeral: bool
}
```

#### Join

Sent by the initiating peer in the [handshake](#handshake) phase.

```cddl
{
    type: "join",
    senderId: peer_id,
    supportedProtocolVersions: protocol_version
    ? metadata: peer_metadata,
}
```

#### Peer

Sent by the receiving peer in response to the join message in the
[handshake](#handshake) phase,

```cddl
{
    type: "peer",
    senderId: peer_id,
    selectedProtocolVersion: protocol_version,
    targetId: peer_id,
    ? metadata: peer_metadata,
}
```

#### Leave

An advisory message sent by a peer when they are planning to disconnect.

```cddl
{
    type: "leave",
    senderId: peer_id,
}
```

#### Request

Sent when the `senderId` is asking to begin sync for the given `documentid`.
Identical to [sync](#sync) but indicates that the `senderId` would like an
[unavailable](#unavailable) message if the `targetId` does not have the
document.

```cddl
{
    type: "request",
    documentId: document_id,
    ; The peer requesting to begin sync
    senderId: peer_id,
    targetId: peer_id,
    ; The initial automerge sync message from the sender
    data: sync_message
}
```

#### Sync

Sent any time either peer wants to send a sync message about a given document

```cddl
{
    type: "sync",
    documentId: document_id,
    ; The peer requesting to begin sync
    senderId: peer_id,
    targetId: peer_id,
    ; The initial automerge sync message from the sender
    data: sync_message
}
```

#### Unavailable

Sent when a peer wants to indicate to the `targetId` that it doesn't have a
given document and all of it's peers have also indicated that they don't have
it

```cddl
{
  type: "doc-unavailable",
  senderId: peer_id,
  targetId: peer_id,
  documentId: document_id,
}
```

#### Ephemeral

Sent when a peer wants to send an ephemeral message to another peer

```cddl
{
  type: "ephemeral",
  ; The peer who sent this message
  senderId: peer_id,
  ; The target of this message
  targetId: peer_id,
  ; The sequence number of this message within its session
  count: uint,
  ; The unique session identifying this stream of ephemeral messages
  sessionId: str,
  ; The document ID this ephemera relates to
  documentId: document_id,
  ; The data of this message (in practice this is arbitrary CBOR)
  data: bstr
}
```

#### Error

Sent to inform the other end that there has been a protocol error and the
connection will close

```cddl
{
    type: "error",
    message: str,
}
```

#### Remote subscription changed

Sent when the sender wishes to change the set of storage IDs they wish to be notified of when the given remotes heads change.

```cddl
{
  type: "remote-subscription-change"
  senderId: peer_id
  targetId: peer_id

  ; The storage IDs to add to the subscription
  ? add: [* storage_id]

  ; The storage IDs to remove from the subscription
  remove: [* storage_id]
}
```

#### Remote heads changed

Sent when the sender wishes to inform the receiver that a peer with a storage ID in the receivers remote heads subscription has changed heads. This is either sent when the local peer receives a new sync message directly from the listened-to peer, or when the local peer receives a `remote-heads-changed` message relating to the listened-to peer from another peer.

```cddl
{
  type: "remote-heads-changed"
  senderId: peer_id
  targetId: peer_id

  ; The document ID of the document that has changed
  documentId: document_id

  ; A map from storage ID to the heads advertised for a given storage ID
  newHeads: {
    * storage_id => {
      ; The heads of the new document for the given storage ID as
      ; a list of base64 encoded SHA2 hashes
      heads: [* string]
      ; The local time on the node which initially sent the remote-heads-changed
      ; message as milliseconds since the unix epoch
      timestamp: uint
    }
  }
}
```
