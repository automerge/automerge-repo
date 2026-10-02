# Backend-driven Repo proof of concept

## Baseline and scope

Branch `acc/repo-backend-poc` starts at `main` (`f1ee0bb3`). Its backend guide is
`acc/repo-poc` at `7420b917`, including supplied-ID backend creation. This is a
new integration, not a wholesale merge of that experiment. The original worktree
and branch are unchanged.

Agreed scope: wire the optional backend into delegate/scheduler orchestration;
keep main's non-deprecated document API where feasible; make creation, import,
and changes awaitable; remove legacy adapters; defer the new query interface.

## Public behavior

- `new Repo()` keeps documents locally, with no fake backend or Subduction import.
- `new Repo({ backend })` owns an injected sedimentree backend, including its
  shutdown. Signers and byte stores retain their backend-documented ownership.
  Each backend documents its own local durability guarantee; the contract has no
  `persistence` classification property.
- `create()` and `import()` return `Promise<DocHandle<T>>`. Backend creation
  allocates an ID and stores initial history before returning, without waiting
  for peers. Local-only creation uses a random 32-byte ID outside the native
  reserved zero-suffix range. Existing URL/UUID utilities remain compatible.
- `change()` mutates and dispatches synchronously, returning a promise for local
  recoverability under that backend's documented guarantee, not peer delivery.
  A rejected save does not undo the edit. `update()`, `merge()`,
  and scoped `remove()` also return persistence promises. `changeAt()` retains
  its synchronous heads return; use `flush()` to await its persistence.
- `clone()` is async because it allocates and stores a new document. It preserves
  the source history rather than introducing an empty preliminary change.
- `find()` returns the shared DocHandle and honors paths, fixed heads and abortable
  waits. Backend readiness requires verified checkpoint history, not the first
  record, advertised remote heads, or successful network round alone.
- `findWithProgress()` remains functional but is deprecated. Existing progress
  `peek`/`subscribe`/`whenReady` support remains; no public `query()`, `RepoQuery`,
  or `RepoHandle` is introduced. Retained UI bindings use progress internally
  where immediate cache reads and reactive loading still require it.
- Root, sub-, range and view handles preserve their registry identity, event
  payloads, scoped patches, history, metadata, diff and mutation options.
- `import(binary, { docId })` creates a supplied unused ID, or merges into its
  existing shared history. A backend create/conflict triggers lookup and merge,
  including when the existing document is only on disk. Import does not replace
  stored history. Concurrent lookups during creation reuse one registered handle.
- `delete()` returns a backend deletion promise. Old handles become deleted;
  local removal is not a replicated tombstone. Explicit acquisition can reuse IDs.
- `removeFromCache()` drains writes and closes a backend-backed entry without
  deleting its history. Local-only eviction rejects because the handle holds
  the only copy. Existing external handles remain readable but cannot edit after
  detachment or shutdown.
- `flush(ids?)` captures targeted writes, retries retained failed batches and
  drains before reporting failures. It does not promise network delivery. The
  scheduler does not report failed raw stores that no delegate owns; callers
  observe those promises directly, though a backend flush may still report them.
  Backend error ledgers may report earlier failed attempts after a successful retry.
- `shutdown()` is idempotent and best-effort: stop mutations, fail pending lookup
  waits, drain accepted work, close sessions and backend, log errors. Use explicit
  `flush()` before shutdown to observe persistence failure. There is no `dispose()`.

## Internal responsibilities

`Document` owns Automerge state and the existing handle registry. A narrow commit
hook captures local records before user listeners run. Incoming application uses
the same event machinery but bypasses local persistence. Reentrant dispatch is
queued in snapshot order so patch payloads remain internally consistent. Remote
heads and sync-info timestamps live on the shared Document, not on its delegate.

`DocumentDelegate` translates records, verifies checkpoints, tracks representation
separately from save confirmation and owns exact unsaved batches. Ambiguous writes
retry original bytes; self-echoes neither generate writes nor acknowledge failures.
Rescan keeps document state and unsaved history, resetting source readiness targets.
Delegate construction installs its commit hook and initial query source immediately;
checkpoint verification uses query snapshot state rather than separate completion
or failure flags. Document owns closed/deleted lifecycle state.

`RepoScheduler` owns sessions, per-ID write ordering, bounded cross-document local
operation concurrency, rescan, detach, deletion generation fences and teardown.
Per-ID tails capture accepted submissions; delegates own retries and unsaved
history. Creations remain tracked until settled, including those without an ID. Flush
waits for captured submissions and retries before calling backend flush once;
when nothing is pending it captures the backend barrier immediately. Later edits
may run ahead of a delayed retry, so flush is not a strict execution-time cutoff.
`flushConcurrency` currently bounds local operations (default 20), not just flush.
Event replay is bounded by backend observation windows; the scheduler does not
claim a bound on session count, queued operations, retained history or total heap.

`Repo` owns the per-ID Document/DocHandle/progress entries, public operations and
creation/import lifecycle. It no longer interprets legacy network messages or
constructs storage adapters and synchronizers.

## Removed and changed surface

Removed core legacy storage/network/synchronizer machinery, adapter interfaces and
exports, sync-state persistence and gossip management, and all five adapter
packages. Removed their incompatible umbrellas, generators, templates, examples
and sync server rather than leaving a broken workspace. React hooks, Solid
primitives and Svelte stores remain and expose awaitable update callbacks.

Removed already-deprecated handle state helpers, `getRemoteHeads`, progress
compatibility getters and legacy compatibility types. Legacy-only Repo options,
hidden subsystems, `create2`/ID factory, peer/storage identity and sharing-policy
operations are not part of this PoC. Connection management and permission policy
belong to the backend. Repo metrics now describe materialized document statistics,
not protocol metrics; legacy `doc-metrics` instrumentation is not implemented.

DocHandle broadcast/presence and remote-head events retain their shapes through
the backend session. Ephemeral `senderId` remains the claimed original source,
not the immediate authenticated relay; it is not authentication evidence.
Broadcast failures are logged; native Subduction currently
rejects network ephemerals as unsupported. Remote-head timestamps are local
advertisement receipt times, not evidence of peer persistence. Backend identity
strings in those events are not interchangeable with legacy storage identities.

## Differences from the guide PoC

| Guide PoC                                        | This PoC                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| Minimal RepoHandle owning its document           | Main's shared Document and full DocHandle registry                            |
| New public RepoQuery/query()                     | Existing find(), deprecated findWithProgress()                                |
| Change events carry a document directly          | Main-compatible payloads, scoped patches, ordered reentrant snapshots         |
| create/change/dispose only                       | Async create/import/clone, rich mutations, export/delete/cache/flush/shutdown |
| Disposal rejects unsaved-history errors          | Explicit rejecting flush plus best-effort shutdown                            |
| One global serial write tail                     | Ordered per-ID tails with bounded cross-ID concurrency                        |
| Retry on edit/disposal                           | Explicit flush retry, detach drain, and shutdown drain                        |
| Controller supplies real two-peer coverage       | Public Repo supplies native two-peer and fragmented restart coverage          |
| Legacy packages left referencing removed exports | Adapter packages and incompatible dependents removed                          |

Kept the guide's plain contract packaging, no default backend, record translation,
local-durability distinction, checkpoint verification and original-byte retry
lessons. The private document controller and new public query/handle types were
not ported.

## Validation

Build packages before testing fresh-process package exports. In this environment
use `corepack pnpm` for top-level invocations; nested scripts invoking a different
global pnpm can encounter its version check.

```sh
corepack pnpm install
corepack pnpm -r exec tsc -p tsconfig.json
corepack pnpm --filter './packages/*' exec tsc --noEmit
corepack pnpm exec vitest run --maxWorkers 4
corepack pnpm exec tsc -p packages/automerge-repo/test/tsconfig.backend-poc.json
corepack pnpm exec tsc -p packages/automerge-repo-subduction/test/tsconfig.json
```

Core tests cover creation/lookup races, identity, async persistence, failures and
flush retry, imports, rich handles, deletion and shutdown. Backend contract and
translation suites cover observation, fragments and lifecycle. Native public Repo
tests cover immediate events, delayed storage, bidirectional/concurrent sync,
2,000-change fragmented history, receiver disk restart, imports into cached and
uncached supplied IDs, no reload write-back, deletion and best-effort shutdown.
Retained document/URL/sub-handle/GC and UI binding regressions run alongside them.

Review found and regression-tested accepted-deletion/shutdown ordering, fixed-head
wait termination on shutdown/deletion/eviction, subscriber exception isolation,
backend-observed generation removal, ephemeral source identity and remote-head
readiness separation. The full run uses four workers to limit native/disk test
contention on this machine; the large-history test has a longer explicit deadline.

The standalone legacy `test/tsconfig.json` is still not clean: retained tests have
nullable-document/contextual-callback errors, and that config omits Node/library
settings required by current declarations. Package typechecks and the focused
backend and native test configs are the checked targets. This does not suppress
runtime execution of the retained suites.

Stage 1 changes preserve a live session for empty connected lookups. A no-peer
round marks the query unavailable for now; an empty round with connected peers
remains loading because native success alone cannot prove whether data will
arrive later. Neither result is evidence of global absence.

## Remaining limits

The native Subduction dependency still requires an unreleased local WASM build;
the workspace override is an absolute checkout link so this temporary worktree
can resolve it. Replace it with a published version before distribution. See
the Subduction README for trusted-peer allow-all authorization, exclusively owned
storage, non-streaming/quadratic history scans, replay budgets and conservative
all-peer disconnection during deletion/storage-error recovery.

Native successful empty reconciliation does not distinguish proven absence from
late/stale advertisements. The query stays loading after an empty connected
round, keeping the session open for new data or ephemerals. No-peer rounds can
settle as unavailable without closing the session.
Reliable remote absence still needs native protocol/API support. Nonempty
advertisements still require verified ingestion.

Production dialing, network ephemerals, scheduling/coalescing beyond bounded local
concurrency, variant-equivalence reclamation, legacy/composite backends, Keyhive
and the next query API remain deferred. This PoC is not a production release.
