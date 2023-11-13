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

The websocket wire protocol consists of a handshake where each peer tells the
other what their peer ID is followed by the sync loop where each peer can send
the other sync messages and ephemeral messages.

### Handshake

Before sync can continue each peer needs to exchange peer IDs and agree on the
protocol version they are using (although currently there is only one version).
Handshake is the following steps:

* Once a connection is established the initiating peer sends a
  [join](#join) message with the `senderId` set to the initiating peers ID and
  the `protocolVersion` set to "1"
* The receiving peer waits until it receives a message from the initiating
  peer, if the initiating peer receives a message before sending the join message
  the initiating peer SHOULD terminate the connection.
* When the receiving peer receives the join message
    * if the `protocolVersion` is not "1" the receiving peer sends an
      [error](#error) message and terminates the connection
    * otherwise
        * store the `senderId` as the peer ID of the initiating peer
        * emit a "peer-candidate" event with the sender ID as the peer
        * respond with a [peer](#peer) message with the `targetId` set to the
          initiating peers peer ID, the `senderId` set to the receiving peers
          peer ID and the `selectedProtocolVersion` set to "1"
        * begin the sync phase
* Once the initiating peer has sent the join message it waits for a peer message
  in response. If it receives any other message type before the join message
  the receiving peer should send an [error](#error) message and terminates the
  connection
* When the initiating peer receives the peer message
  * it stores the `senderId` as the peer ID of the receiving peer.
  * it emits a "peer-candidate" event with the sender ID as the peer
  * if the `selectedProtocolVersion` is anything other than "1" the initiating
    peer sends an [error](#error) message and terminates the connection
  * it begins the sync phase


### Sync Phase

In the sync phase either side may send a [request](#request), [sync](#sync),
[unavailable](#unavailable), or [ephemeral](#ephemeral) message. Sending these
corresponds to implementing
[`NetworkAdapter.send`](https://automerge.org/automerge-repo/classes/_automerge_automerge_repo.NetworkAdapter.html#send)
and receiving is emitting the [corresponding
event](https://automerge.org/automerge-repo/interfaces/_automerge_automerge_repo.NetworkAdapterEvents.html)
from the `NetworkAdapter` on receipt.

### Message Types

All messages are encoded using CBOR and are described in this document using
[cddl](https://datatracker.ietf.org/doc/html/rfc8610)

#### Preamble

These type definitions are used in every message type

```cddl
; The base64 encoded bytes of a Peer ID
peer_id = str
; The possible protocol versions (currently always the string "1")
protocol_version = "1"
; The bytes of an automerge sync message
sync_message = bstr
; The base58check encoded bytes of a document ID
document_id = str
```

#### Join

Sent by the initiating peer in the [handshake](#handshake) phase.

```cddl
{
    type: "join",
    senderId: peer_id,
    supportedProtocolVersions: protocol_version
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
