# Automerge ↔ sedimentree (experimental)

Private, provisional translation helpers for Automerge **3.3.2** and
`@automerge/automerge-repo-sedimentree`. Public exports of this experimental
package are not a stable API. There is no Repo, controller, backend, storage,
network, or runtime initialization here. The library imports **Automerge slim**;
the application must initialize that runtime first. Tests import fullfat, as
Repo's existing tests do. Package exports/types point to compiled `dist`; tests
exercise `src`.

## API

```ts
getRecordMetadata(doc: Doc<unknown>): RecordMetadata[]
recordMetadataKey(metadata: RecordMetadata): string
extractRecords(doc: Doc<unknown>, select?: RecordPredicate): SedimentreeRecord[]
validateRecord(record: SedimentreeRecord): SedimentreeRecord
applyRecords<T>(doc: Doc<T>, records: RecordBatch, options?: ApplyRecordsOptions): Doc<T>
satisfiesCheckpoint(doc: Doc<unknown>, heads: readonly CommitId[]): boolean
```

`RecordMetadata` is the contract's commit/fragment union without `blob`;
`RecordPredicate` receives that metadata. `ApplyRecordsOptions` accepts
`maxBatchBytes` (default 4 MiB) and `maxBatchRecords` (default 256).

Extraction calls `getFragmentMetadata`, projects canonical IDs and sorted,
deduplicated metadata sets, applies the optional predicate, and calls
`bundleFragmentMetadata` **only for the selected native metadata**. Level zero
becomes loose commits; higher levels become fragments. Full Automerge checkpoint
hashes become the contract's **12-byte prefixes**, using `checkpointForCommit`.
No fragments are decoded or serialized to make the selection. Metadata passed to
the predicate is frozen; output bytes belong to the caller.

`recordMetadataKey` includes the complete canonical metadata, not just a head.
It is **not** a blob fingerprint, representation equality, or coverage proof.
Neither matching heads nor matching metadata authorizes discarding arbitrary
incoming representations. Controllers must separately track persistence attempts,
acknowledgments, representations, and proven coverage; a failed store must remain
retryable. These helpers maintain no such state.

## Loading and readiness

`applyRecords` validates/copies the incoming records, concatenates bounded groups
of mixed raw changes and bundles, and feeds them to `loadIncremental`. Each load
uses the preceding result, retaining pending dependencies and local edits. Pass
in the **latest** document and retain the return value; between calls, edit that
returned document normally. Replays and arbitrary delivery order are supported.
No history is deduplicated by head, and no document is reconstructed via
`saveSince`, which would lose pending changes.

The byte limit bounds concatenation, not total memory: a larger single record is
loaded alone without a concatenation allocation. The caller must bound input
batch sizes and individual records; validation copies the supplied batch and
`readBundle` decodes one fragment at a time. All metadata checks occur before the
first load, but this is **not a transaction**: a later Automerge load failure has
no rollback guarantee. There is no asynchronous borrowing of caller buffers,
including `Buffer` and `Uint8Array.subarray` inputs.

`satisfiesCheckpoint` checks **history inclusion** with `hasHeads`. An older
checkpoint remains satisfied after newer local edits, and unrelated pending
changes do not prevent one complete source from satisfying its checkpoint.
An empty target always returns false: it is not evidence of document readiness.
Targets are full commit IDs, not fragment checkpoint prefixes.

## Validation scope and limitations

- Contract ID lengths, hex encoding, nonempty blobs and canonical metadata sets
  are checked. Loose commits are decoded and their hashes and dependency sets
  must match the claimed ID and parents.
- Each record must contain exactly one complete chunk: a loose change (possibly
  compressed), or a fragment bundle. We validate the public [binary chunk
  framing and checksum](https://automerge.org/automerge-binary-format-spec/)
  explicitly. In 3.3.2, `readBundle` ignores trailing chunks and `loadIncremental`
  can silently discard records on checksum corruption. Uncompressed change and
  bundle checksums use SHA-256; compressed changes retain the uncompressed change
  hash's checksum. All records are checked before any are applied.
- Public `readBundle` verifies parseability and exposes the encoded changes. We
  check unique member hashes, the single tip against the claimed head, and
  membership of every claimed checkpoint prefix in the encoded history.
- A sedimentree boundary is not the bundle's immediate external dependency set,
  nor necessarily its superset in repeatedly merged histories. We preserve but
  cannot authenticate it using the standalone blob. The blob also cannot prove
  completeness of checkpoint metadata, prefix uniqueness, or the exact canonical
  sedimentree partition/level. We do **not**
  authenticate those claims or infer reclamation/coverage from them. This package
  is not an adversarial-data certification boundary. `addFragments` is not used
  and must not be mistaken for validation of fragment metadata claims.
- Extraction describes **materialized history**, not queued changes with missing
  dependencies. It is not by itself a durable representation of pending state.
  A future backend must retain pending records or persist a format proven to
  preserve them (for example, a full Automerge save), not acknowledge persistence
  based only on current heads or extraction results.
- Automerge fragment APIs are experimental. 3.3.2 bundles are not generally
  readable by 3.2.6; legacy interoperability must use supported changes/full
  snapshots rather than forwarding this bundle encoding unchanged.

Tests use a fixed-actor, all-times-zero 2,000-change fixture, plus deterministic
forks. They cover metadata-only selection, fragments and loose commits, duplicates,
bounded mixed loads, pending dependencies, edits during loading, checkpoint
inclusion, malformed metadata/payloads, and buffer ownership.
