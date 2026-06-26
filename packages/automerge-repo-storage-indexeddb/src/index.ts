/**
 * Storage adapters for IndexedDB.
 *
 * - {@link IndexedDBStorageAdapter} — runs on whichever thread constructs it.
 * - {@link IndexedDBWorkerStorageAdapter} — drop-in adapter that runs the
 *   IndexedDB work in a Worker (off the main thread).
 *
 * @packageDocumentation
 */

export { IndexedDBStorageAdapter } from "./IndexedDBStorageAdapter.js"
export { IndexedDBWorkerStorageAdapter } from "./IndexedDBWorkerStorageAdapter.js"
