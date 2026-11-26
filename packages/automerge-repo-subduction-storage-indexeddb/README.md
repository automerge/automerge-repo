# Automerge Repo Subduction IndexedDB storage adapter

Browser storage for `@automerge/automerge-repo-subduction`: an
`IndexedDBStorageAdapter` implementing
`SubductionStorageAdapterInterface`.

```ts
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"

const storage = new IndexedDBStorageAdapter()
const backend = new SubductionBackend({ storage })
// ... after repo.shutdown() and backend.close():
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
