# Storage error handling

Guidance on what happens when storage I/O fails in `automerge-repo`, and where
the responsibility for reliability lies. The behavior described here is
implemented in [`src/StorageSource.ts`](../src/StorageSource.ts); the adapter
contract applies to implementations of
[`src/storage/StorageAdapterInterface.ts`](../src/storage/StorageAdapterInterface.ts).

## What `StorageSource` guarantees

When a throttled save rejects (a disk/IO error, quota exceeded, an aborted
IndexedDB transaction, a failed remote write, and so on), `StorageSource`
catches the error and logs it rather than letting it escape. Two properties
follow:

- **The process stays up.** The save runs fire-and-forget from a
  `"heads-changed"` listener, so an unhandled rejection would, in Node, exit the
  process by default. Catching it keeps the repo alive.
- **The change is retained in memory.** Nothing is dropped. A later save or a
  reload re-persists the current document, because `lastSavedHeads` only
  advances on a successful write, so the next successful save re-includes
  whatever a failed one did not persist.

This is deliberately the only thing `StorageSource` does about a failed write.
It converts a fatal crash into a recoverable condition, which buys time for the
recovery strategies below. It does not retry, back off, or escalate. That is not
its job (see the contract below).

## The storage adapter contract

A `StorageAdapter` should be designed to be robust. Most failure handling
belongs in the adapter rather than in `StorageSource`, because only the adapter
knows its backend.

- **Recoverability is the adapter's call.** Many storage failures are rare and
  transient: a momentary lock, a quota blip, a 503 from a remote store. The
  adapter is the layer that can distinguish a transient failure from a permanent
  one.
- **Retry and backoff are a consideration, not a mandate.** Exponential backoff
  is one reasonable strategy for some backends, but it is not always the right
  answer and it is not the only one. Whether and how to retry depends on the
  backend's semantics, which is precisely why the policy lives in the adapter
  and not in a generic layer that cannot know those semantics.
- **Escalation is the adapter's responsibility** when a failure is genuinely
  unrecoverable. How to escalate (surface to the host, fail a health check, and
  so on) is backend- and deployment-specific.

## Reliability strategies to consider

If durability is a concern, there is more than one lever, and adapter-level
retry is rarely the most important one:

- **Network redundancy via peers.** This is usually the strongest lever. The
  repo instances you connect to each have their own storage adapter, so a
  document synced to peers is already durable in more than one place. A local
  storage failure does not lose data that a connected peer holds; once storage
  recovers, normal sync re-persists it. Designing for connectivity to a
  well-provisioned peer (for example a sync server backed by reliable storage)
  buys more real durability than hardening any single adapter.
- **Adapter-level retry and backoff.** Useful for transient backend failures,
  with the caveats above. Evaluate it per backend; do not assume it is
  sufficient on its own.
- **Other strategies.** Depending on requirements, writing through to more than
  one backend, putting a durable queue in front of a flaky store, or periodic
  reconciliation may fit better than retry alone. Treat the options above as a
  starting point, not an exhaustive list.

## Observability and alerting

Persistent failures need to be visible; otherwise a server can look healthy
while silently failing to persist. `automerge-repo` surfaces these through its
logger: a failed save is reported via `logger.error(...)` under the relevant
subsystem namespace (for example `automerge-repo:storage-source`).

The logger is pluggable. By default `.debug` output is routed through the
[`debug`](https://www.npmjs.com/package/debug) package (filter with
`DEBUG=automerge-repo:*`), and `info` / `warn` / `error` go to `console`. The
`Logger` interface is shaped to match `console`, [pino], and [winston], and
[`setLoggerFactory`](../src/Logger.ts) routes all automerge-repo output through
your own logger when called once at startup:

```ts
import { setLoggerFactory } from "@automerge/automerge-repo"
import winston from "winston"

const logger = winston.createLogger({
  /* ... */
})

setLoggerFactory(namespace => ({
  debug: (msg, ...args) => logger.debug(msg, { namespace, args }),
  info: (msg, ...args) => logger.info(msg, { namespace, args }),
  warn: (msg, ...args) => logger.warn(msg, { namespace, args }),
  error: (msg, ...args) => logger.error(msg, { namespace, args }),
}))
```

A reasonable production setup ships these logs to a backend that supports
alerting (for example by exporting them through OpenTelemetry) and alerts on
persistent storage errors. Configuring the logger and wiring an
observability and alerting layer is the responsibility of the application
embedding `automerge-repo`. The library's job is to emit the events at a
sensible level and namespace; routing and alerting are deployment concerns.

## Why there is no first-class storage error event

We intentionally do not expose a typed `storage-error` event or signal. The
logging path already exists and is configurable as above, escalation policy
belongs in the adapter, and redundancy comes from the network. A separate
in-process error signal would duplicate the logger and would invite
backend-specific recovery policy into a layer that should stay
backend-agnostic. A consumer that wants programmatic handling can supply a
custom `LoggerFactory` that inspects the namespace and level.

[pino]: https://github.com/pinojs/pino
[winston]: https://github.com/winstonjs/winston
