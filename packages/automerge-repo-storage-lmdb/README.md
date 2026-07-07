# Automerge-Repo Storage: LMDB

An [LMDB](https://www.symas.com/lmdb) storage adapter for
[automerge-repo](https://github.com/automerge/automerge-repo), for Node ≥22.

```ts
import { Repo } from "@automerge/automerge-repo"
import { LMDBStorageAdapter } from "@automerge/automerge-repo-storage-lmdb"

const repo = new Repo({
  storage: new LMDBStorageAdapter("./data/automerge.lmdb"),
})
```

## Why LMDB

- _Ordered `string[]` keys._ `StorageKey`s are stored natively (lmdb-js
  `ordered-binary` encoding) with component-wise ordering, so range loads
  are cursor scans with no key-encoding layer.
- _Memory-mapped reads._ Point loads are zero-syscall lookups.
- _Atomic batches._ `saveBatch` runs in a single LMDB transaction —
  all-or-nothing, strictly stronger than the interface's two-phase
  stage/commit contract.
- _No system dependencies._ The `lmdb` package vendors and statically
  compiles LMDB; npm installs a prebuilt binary on mainstream platforms
  (Linux glibc/musl, macOS, Windows, x64/arm64) and falls back to node-gyp
  elsewhere.

## Bring your own database

Pass an open lmdb-js database instead of a path to share an environment
with the rest of your app (it must use `binary` value encoding and the
default key encoding). A supplied database is not closed by
`adapter.close()`.

```ts
import { open } from "lmdb"

const db = open({ path: "./data", encoding: "binary" })
const adapter = new LMDBStorageAdapter(db)
```

## Caveats

- Native addon: single-file JS bundles must ship the `.node` binary
  alongside (mark `lmdb` as external).
- `saveBatch` commits synchronously (an aborting transaction requires the
  sync form in lmdb-js), so very large batches briefly block the event
  loop; `save` uses the non-blocking async commit path.
