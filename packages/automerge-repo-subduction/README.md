# Automerge Repo Subduction backend (experimental)

**Experimental, not production-ready.** Requires exclusively owned storage and
explicitly trusted peers. Uses `@automerge/subduction` 0.23.0.

## Quick start

```ts
// Node: initialize fullfat WASM before constructing the slim-backed peer.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import { createSubductionPeer } from "@automerge/automerge-repo-subduction"

const peer = createSubductionPeer({ servers: ["ws://127.0.0.1:8080"] })
const repo = new Repo({ backend: peer.backend })
try {
  const handle = await repo.create({ message: "Hello" })
  console.log(peer.peerId, handle.documentId)
  // Keep Repo and peer alive while using this handle.
} finally {
  try {
    await repo.shutdown()
  } finally {
    await peer.close()
  }
}
```

The package imports `@automerge/subduction/slim` and does not initialize WASM.
Browser apps must await the matching native initializer before creating a peer.
By default `createSubductionPeer()` uses an in-memory signer and byte store:
identity and history do not survive restart. Injected signers and stores are
borrowed; keep them alive until after `peer.close()`. Use valid Ed25519 signer
keys, as native code can panic on invalid keys.

### IndexedDB byte store

For persistent local history in a browser, pass `new IndexedDBByteStore()` as
`storage`. It uses the `automerge-repo-subduction` database and `bytes` object
store by default; pass `{ database, store }` to override them. Existing object
stores must use out-of-line keys without autoIncrement. A completed save does
not guarantee fsync or protection from browser eviction.

After shutting down Repo and closing the peer, call `await storage.close()` to
release its database connection. If an open is blocked, close other database
clients before retrying.

```ts
// Node initializer shown; browsers must await their native WASM initializer.
import "@automerge/subduction"
import { Repo } from "@automerge/automerge-repo"
import {
  createSubductionPeer,
  IndexedDBByteStore,
} from "@automerge/automerge-repo-subduction"

const storage = new IndexedDBByteStore()
const peer = createSubductionPeer({ storage, servers: ["ws://127.0.0.1:8080"] })
const repo = new Repo({ backend: peer.backend })
try {
  // ... use repo ...
} finally {
  try {
    await repo.shutdown()
  } finally {
    try {
      await peer.close()
    } finally {
      await storage.close()
    }
  }
}
```

Inject a persistent signer if peer identity must survive reloads. Use one live
backend per database, including across browser tabs and custom object stores;
concurrent local deletes and writes are not coordinated across tabs.

### Server connections

`servers` accepts WebSocket URL strings, `URL` objects, or `{ url, serviceName? }`.
Configured servers connect immediately; `peer.connect(server)` adds another
connection to `peer.connections`.

Use `connection.connected()` to wait for a connection; it retries by default.
Configure `retry: { initialMs, maxMs }` or `retry: false`, and use
`connection.reconnect()` to retry immediately. `connectTimeoutMilliseconds`
defaults to 10 seconds for opening, authentication and backend onboarding.

`connection.close()` closes only its socket. Call `repo.shutdown()` before
`peer.close()`; call `repo.flush()` first to observe persistence failures.

For an existing backend and signer, use `connectSubductionServer` directly:

```ts
import { connectSubductionServer } from "@automerge/automerge-repo-subduction"

const connection = connectSubductionServer(backend, signer, serverUrl, {
  retry: false,
  connectTimeoutMilliseconds: 10_000,
})
try {
  await connection.connected()
  // Use the existing backend.
} finally {
  await connection.close()
}
```

This borrows both backend and signer; it closes neither.

## Construction and ownership

```ts
// Node: initialize fullfat BEFORE constructing the slim-backed implementation.
import { MemorySigner } from "@automerge/subduction"
import { SubductionBackend } from "@automerge/automerge-repo-subduction"

const signer = MemorySigner.generate()
const backend = new SubductionBackend({
  signer,
  storage: byteStore,
})
// ... use the plain SedimentreeBackend contract ...
await backend.close()
signer.free()
```

Browser apps must initialize native WASM first. The signer is **borrowed**: keep
it alive until close completes, then free it yourself.

The injected `LocalByteStore` has exactly:

```ts
load(key: string): Promise<Uint8Array | undefined>
save(key: string, data: Uint8Array): Promise<void>
remove(key: string): Promise<void>
list(prefix: string): Promise<string[]> // full keys with this prefix
```

`save` **must atomically replace one entire value**. Successful resolution must
mean recoverable under the store's documented guarantees (not necessarily fsync).
Missing values are `undefined`; `remove` is idempotent. Do not mutate supplied
bytes. The `subduction-v1/` namespace must be exclusively owned by this backend.
Storage is borrowed and is not closed or erased by backend close. Concurrent
multi-owner access and hostile storage are unsupported.

## Low-level authenticated peer connections

Pass an already authenticated native transport to `backend.addConnection()`.
For example, on the dialing side (the remote side must concurrently call native
`AuthenticatedTransport.accept()` and add its result to its own backend):

```ts
import { AuthenticatedTransport, PeerId } from "@automerge/subduction"

const expectedPeer = new PeerId(remotePublicKeyBytes)
try {
  const authenticated = await AuthenticatedTransport.setup(
    transport, // native Transport: sendBytes/recvBytes/disconnect/onDisconnect
    signer,
    expectedPeer
  )
  try {
    await backend.addConnection(authenticated)
  } finally {
    authenticated.free()
  }
} catch (error) {
  await transport.disconnect()
  throw error
} finally {
  expectedPeer.free()
}
```

`addConnection` borrows the authenticated wrapper until its promise settles;
keep the underlying JS transport alive until disconnect. Callers own dialing,
handshake cleanup, and reconnection. Native uses **allow-all authorization**;
authenticated identity is not an application sharing policy. Connect only
explicitly trusted peers. A successful synchronization round does **not** prove
remote durability, document readiness, or global convergence.

### Empty connected lookups

Native 0.23.0 cannot prove that a remote document is absent. An empty connected
lookup stays loading, even after successful synchronization. A no-peer round may
mark it unavailable for now; neither result proves global absence. Deletion and
storage-error recovery disconnect **all** peers, including those used by unrelated
documents. Helper-managed connections retry; low-level callers must reconnect.

### Ephemeral messages

`handle.broadcast(message)` uses best-effort, nonpersistent native pubsub. The
event's `sender` is the signature-verified originator, not the immediate relay;
`message.origin` is untrusted. Encoded envelopes are limited to 64 KiB. Message
IDs must be unique across publishers on a topic; reused IDs can drop messages.
Sending with no connected peers is a no-op. Resolution is not a delivery
acknowledgment; messages have no receipts, retries, or replay after reconnection.

## Persistence and integrity

Records are saved atomically **per record**, not as a batch transaction. A
partially failed batch may already be observable. Malformed records fail rather
than appearing absent; the checksum detects damage, not malicious tampering.
Conflicting representations of the same tree/kind/head are rejected; variant
equivalence and compaction are not supported.

Observers must handle duplicate durable deliveries. A watch that exceeds its
replay budget ends with `rescan-required`. `flush()` drains accepted local work
and reports persistence failures, but does not wait for peer delivery. A
successful retry does not erase previously unreported failures.

## Limits

Default limits:

| Option                    |                                                         Default |
| ------------------------- | --------------------------------------------------------------: |
| `syncTimeoutMilliseconds` |                                5,000 ms per native peer request |
| `maxRecordBytes`          |                       16 MiB (native signed metadata plus blob) |
| `maxBatchBytes`           | 64 MiB encoded per native write chunk (one larger record alone) |
| `batchRecords`            |       128 records per native write chunk and per delivery event |
| `batchBytes`              |        1 MiB initial delivery target; one larger record allowed |
| `replayEvents`            |                                                   128 per watch |
| `replayBytes`             |                                                 4 MiB per watch |

A save reads only its own key (to detect a conflicting representation and
duplicate notifications) and then writes; it does not rescan the tree. A
`store()`/`create()` submission of any size is accepted: it is validated up
front (per-record size, wire counts, same-key conflicts within the batch and
against storage), then written in chunks of at most `batchRecords` records and
`maxBatchBytes`, so WASM only holds one chunk's signed inputs at a time. A
chunk that fails leaves earlier chunks durable; the whole batch is safe to
retry and already-written records dedupe. There is **no cap on a tree's total
history**: whatever was accepted can always be reopened, enumerated, synced and
deleted. Opening a tree still reads its whole history into memory, so very
large trees cost time and heap proportional to their size rather than being
refused. Once every session on a tree has called `markComplete()`, live and
sync-round checkpoints are reported from the heads delivered so far instead of
rereading storage. These limits bound encoded records, not total heap use,
session count, or queued operations. This is not a streaming or production
large-history write path.

## Dependency and tests

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm exec vitest run --project repo-subduction
pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```
