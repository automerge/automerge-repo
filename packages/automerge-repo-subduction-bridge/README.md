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
import { Repo } from "@automerge/automerge-repo/slim"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import {
  initSubductionModule,
  setupSubduction,
} from "@automerge/automerge-repo-subduction-bridge"
import { initSync } from "@automerge/automerge-subduction/slim"
import * as SubductionModule from "@automerge/automerge-subduction/slim"
import { WebCryptoSigner } from "@automerge/automerge-subduction/slim"
import { wasmBase64 } from "@automerge/automerge-subduction/wasm-base64"

// 1. Initialize the Wasm module (use /slim to avoid bundler class identity issue)
initSync(Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)))
initSubductionModule(SubductionModule)

// 2. Set up Subduction
const signer = await WebCryptoSigner.setup()
const { subduction, storage } = await setupSubduction({
  subductionModule: SubductionModule,
  signer,
  storageAdapter: new IndexedDBStorageAdapter("my-app"),
})

// 3. Connect to a server
await subduction.connectDiscover(new URL("ws://localhost:8080"))

// 4. Create the Repo
const repo = new Repo({
  network: [],
  subduction,
})
```

## License

MIT
