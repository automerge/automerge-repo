# Automerge ↔ sedimentree (experimental)

Provisional translation helpers for Automerge **3.5.0**, exported by
`@automerge/automerge-repo/sedimentree/automerge`. Uses the plain contract from
`@automerge/automerge-repo/sedimentree`. These experimental subpath exports are
not a stable API. There is no repository orchestration, controller, backend,
transport, or runtime initialization here. This module imports **Automerge slim**;
the application must initialize that runtime first. Package exports/types
point to compiled `dist`; tests exercise `src`.

## API

```ts
extractRecords(doc: Doc<unknown>): SedimentreeRecord[]
extractNewCommits(before: Doc<unknown>, after: Doc<unknown>): LooseCommitRecord[]
extractFragments(doc: Doc<unknown>, heads: Iterable<CommitId>): { records: FragmentRecord[]; absent: CommitId[] }
isBoundary(id: CommitId): boolean
applyRecords<T>(doc: Doc<T>, records: RecordBatch): Doc<T>
satisfiesMarker(doc: Doc<unknown>, heads: readonly CommitId[]): boolean
```

Extraction calls `getFragmentMetadata`, projects canonical IDs and sorted,
deduplicated metadata sets, and calls `bundleFragmentMetadata` once. Level zero
becomes loose commits; higher levels become fragments. Full Automerge checkpoint
hashes become the contract's **12-byte prefixes**, using `checkpointForCommit`.
The pinned version includes the [3.5.0 fragment checkpoint fix](https://raw.githubusercontent.com/automerge/automerge/4d2a8f6bfecfb7f1e4fca126e6d2122ac526f903/javascript/CHANGELOG.md):
checkpoints exclude the fragment's head and boundary hashes, while the head
remains in its members. Regression tests cover metadata and bundled APIs.
Output bytes belong to the caller.

`extractNewCommits` returns every change added since `before` as a loose commit,
via `getChangesSince(after, getHeads(before))`, boundaries included; it never
enumerates fragment metadata. `isBoundary` identifies commits that head a
fragment (hash starting with a zero byte). `extractFragments` bundles the
fragments headed by given boundary commits with one `getFragmentMeta` lookup per
head, not a full metadata scan; heads with no fragment of their own (absorbed
into a higher fragment, or unknown to the document) are returned as `absent`.
Repo uses these to store edits loose and compact boundaries later. Deletion of
superseded records is not performed.

Neither matching heads nor matching metadata authorizes discarding arbitrary
incoming representations. Controllers must separately track persistence attempts,
acknowledgments, representations, and proven coverage; a failed store must remain
retryable. These helpers maintain no such state.

## Loading and readiness

`applyRecords` concatenates the supplied blobs (mixed raw changes and bundles)
and feeds them to `loadIncremental` in one call. Each load uses the preceding
result, retaining pending dependencies and local edits. Pass in the **latest**
document and retain the return value; between calls, edit that returned document
normally. Replays and arbitrary delivery order are supported. No history is
deduplicated by head, and no document is reconstructed via `saveSince`, which
would lose pending changes. The Repo may skip an incoming record whose claimed
head is already applied: valid commits and single-tip fragments add no history
in that case.

The caller bounds batch sizes. Loading is **not a transaction**: an Automerge
load failure has no rollback guarantee. The concatenation copies the input, so
there is no asynchronous borrowing of caller buffers, including `Buffer` and
`Uint8Array.subarray` inputs.

`satisfiesMarker` checks **history inclusion** with `hasHeads`. An older
marker remains satisfied after newer local edits, and unrelated pending
changes do not prevent one complete source from satisfying its marker.
An empty target always returns false: it is not evidence of document readiness.
Targets are full commit IDs, not fragment checkpoint prefixes.

## Integrity

Records are trusted here. The backend is responsible for integrity: Subduction
verifies signatures and blob digests on store, on ingest from peers and on
hydration from storage. This module performs no framing, checksum or
metadata-versus-payload checks; Automerge load errors propagate to the caller.

- Extraction describes **materialized history**, not queued changes with missing
  dependencies. It is not by itself a durable representation of pending state.
  A future backend must retain pending records or persist a format proven to
  preserve them (for example, a full Automerge save), not acknowledge persistence
  based only on current heads or extraction results.
- Automerge fragment APIs are experimental; bundled history requires compatible
  Automerge runtimes.

Tests use a fixed-actor, all-times-zero 2,000-change fixture, plus deterministic
forks. They cover fragments and loose commits, duplicates,
pending dependencies, edits during loading, history inclusion, and buffer
ownership.

From the workspace root:

```sh
pnpm --filter @automerge/automerge-repo build
pnpm exec vitest run packages/automerge-repo/test/sedimentree-automerge/
pnpm exec tsc -p packages/automerge-repo/test/sedimentree-automerge/tsconfig.json
```
