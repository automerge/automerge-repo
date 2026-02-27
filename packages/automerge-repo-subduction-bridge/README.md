# @automerge/automerge-repo-subduction-bridge

Bridges [automerge-repo](https://github.com/automerge/automerge-repo) storage and network adapters to [Subduction](https://www.npmjs.com/package/@automerge/automerge-subduction), a Rust/Wasm CRDT sync engine.

## Installation

```bash
npm install @automerge/automerge-repo-subduction-bridge@subduction
```

## What's in the box

- **`SubductionStorageBridge`** — wraps any automerge-repo `StorageAdapterInterface` to implement Subduction's storage, emitting `commit-saved` and `fragment-saved` events
- **`NetworkAdapterConnection`** — wraps any automerge-repo `NetworkAdapterInterface` to implement Subduction's `Connection`, with CBOR encoding and request/response correlation
- **`setupSubduction()`** — convenience helper for initializing Subduction with a signer and storage bridge
- **`initSubductionModule()`** — registers the Wasm module with automerge-repo core

## Quick start

```typescript
import { Repo } from "@automerge/automerge-repo"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import {
  initSubductionModule,
  setupSubduction,
} from "@automerge/automerge-repo-subduction-bridge"
import * as SubductionModule from "@automerge/automerge-subduction"
import {
  Subduction,
  SubductionWebSocket,
  WebCryptoSigner,
} from "@automerge/automerge-subduction"

// 1. Initialize the Wasm module
initSubductionModule(SubductionModule)

// 2. Set up Subduction
const signer = await WebCryptoSigner.setup()
const { subduction, storage } = await setupSubduction({
  signer,
  storageAdapter: new IndexedDBStorageAdapter("my-app"),
})

// 3. Connect to a server
const conn = await SubductionWebSocket.tryDiscover(
  new URL("ws://localhost:8080"),
  signer
)
await subduction.attach(conn)

// 4. Create the Repo
const repo = new Repo({
  network: [],
  subduction,
})
```

## License

MIT
