# Automerge Repo Subduction IndexedDB storage adapter (experimental)

Browser storage for `@automerge/automerge-repo-subduction`: an
`IndexedDBSubductionStorageAdapter` implementing
`SubductionStorageAdapterInterface`.

```ts
import { createSubductionPeer } from "@automerge/automerge-repo-subduction"
import { IndexedDBSubductionStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"

const storage = new IndexedDBSubductionStorageAdapter()
const peer = createSubductionPeer({ storage, servers: ["wss://example.com"] })
// ... after repo.shutdown() and peer.close():
await storage.close()
```

It uses the `automerge-repo-subduction` database and `bytes` object store; pass
`{ database, store }` to choose names for another dedicated database. The chosen
store is created only when the database is new. Each `saveBatch` and
`removeBatch` is one readwrite transaction. A completed save does not guarantee
fsync or protection from browser eviction. `close()` releases the database
connection; later calls reopen it.

Use one live backend per database, including across browser tabs and custom
object stores; concurrent local deletes and writes are not coordinated across
tabs.
