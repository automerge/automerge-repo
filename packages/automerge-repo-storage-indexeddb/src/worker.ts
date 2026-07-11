/// <reference lib="webworker" />
/** Dedicated-worker entrypoint for {@link IndexedDBWorkerStorageAdapter}. */
import type { WorkerPortLike } from "@automerge/automerge-repo/slim"
import { attachStorageHost } from "./worker-host.js"

attachStorageHost(self as unknown as WorkerPortLike)

export {}
