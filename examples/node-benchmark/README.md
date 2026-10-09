# Node slow-load benchmark

Fast, storage-neutral diagnostic companion to `../browser-benchmark/`. Compares
`base/main`, `base/subductionjs`, and the current `poc` worktree. This is **not**
a browser responsiveness, IndexedDB, or durability benchmark. Do not compare
its times with the browser reports.

From the workspace root:

```sh
pnpm install
pnpm bench:fixtures                    # only if fixtures missing
pnpm bench:node --smoke --runs=3       # 10 documents, quick check
pnpm bench:node --runs=3               # 10, 100, 500, 1000 documents
pnpm bench:node --smoke --runs=1 --profile  # CPU profile last load size
pnpm --filter @automerge/automerge-repo-node-benchmark parity
```

`bench:node` reuses prepared `main`/`subductionjs` worktrees from `bench:prepare`
(or prepares them on first run), builds the current `poc`, and runs each target
in its own Node process. Each process reads and SHA-256-verifies the same browser
fixture manifest, seeds through Repo outside timing, shuts down, and reopens
a fresh Repo for each load size. All `find()` calls are submitted in one wave;
the loaded count is verified. Seeded bytes are retained in one process-local
store, so no disk cache or network work is included. For each target, rounds
reuse that store. Full runs seed 1,000 documents even when measuring 10.

Each round additionally benchmarks fresh-memory-store writes: 100 new 32-item documents created in batches of 20, and 500 back-to-back changes to one document (10 and 30 in smoke mode). The burst's initial create/flush is untimed setup. Raw samples record per-call latency, submission, flush/promise drain, total time, storage operations and store size. Each store is reopened and every created document (or the burst's final state) verified before the sample enters the summary. Node timing is storage-neutral and **not** a UI responsiveness measurement; compare browser frame gaps and Long Tasks for that. Write times are not comparable with browser IndexedDB results, paced edits or imports.

Node also times imports separately from untimed load seeding. Each fixture imports into a fresh memory store, followed by a separately timed `flush()` and an untimed reopen verification. Smoke runs import three small load fixtures and one each of the medium and large history fixtures; full runs use 20 small fixtures and three of each medium, large, and text-history fixture. Import fixture bytes and manifest are SHA-256 verified before timing. A rejected import or failed reopen remains a failed raw sample, excluded from its class summary. Like browser imports, `importMs` is not necessarily durable until `flushMs` completes; unlike browser imports, Node timings exclude IndexedDB costs.

All three targets use `memory.mjs`: the same byte-copying backing store and
tree-indexed prefix lookup, wrapped for the legacy `StorageAdapterInterface`
or `LocalByteStore`. Legacy keys are arrays; PoC keys are strings. This avoids
the full-store scan in `main`'s dummy adapter and the shared-first-segment scan
in `subductionjs`'s dummy adapter. **The adapters have different record layouts
and request counts**; the benchmark does not normalize those. Reports include
per-operation calls, summed time, returned values, stored keys/bytes, and raw
per-round latency distributions. Operation times overlap under concurrent
loads: do not add them to obtain wall-clock time. Results are ignored under
`results/`.
The `parity` command checks identical prefix-result counts and reports isolated
adapter lookup timings for 100 trees × 48 records; timings are **not** a gate.
`--profile` saves a `.cpuprofile` per target for the first round's largest
load case only (10 with `--smoke`, otherwise 1,000). Open it in Chrome DevTools;
profiling adds overhead, so use unprofiled runs for comparisons.

The browser benchmark remains the check for UI responsiveness and IndexedDB
performance. Changes in Node's WASM/native initialization, memory behavior,
or fixture shape can change these results; compare only runs with matching
fixture hashes and Node versions.
