# Automerge Repo Subduction WebSocket network adapter (experimental)

A WebSocket client for `@automerge/automerge-repo-subduction`: a
`WebSocketSubductionNetworkAdapter` implementing
`SubductionNetworkAdapterInterface`.

```ts
import { SubductionBackend } from "@automerge/automerge-repo-subduction"
import { WebSocketSubductionNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"

const server = new WebSocketSubductionNetworkAdapter("wss://example.com", {
  retry: { initialMs: 500, maxMs: 30_000 },
  connectTimeoutMilliseconds: 10_000,
})
const backend = new SubductionBackend({ storage, network: [server] })
await server.connected()
```

The server is a WebSocket URL string, a `URL`, or `{ url, serviceName? }`; the
service name used for discovery defaults to the URL's host. The backend starts
the adapter at construction and stops it in `backend.close()`; the handshake is
signed with the backend's signer.

Connection attempts retry with jittered exponential backoff by default;
configure `retry: { initialMs, maxMs }` or disable it with `retry: false`.
`connectTimeoutMilliseconds` (default 10 seconds) bounds socket opening,
authentication and backend onboarding. The first attempt settling, successful
or not, is what lets lookups of missing documents proceed, so this deadline
also bounds how long they wait on an unreachable server.

`status` is `idle`, `connecting`, `connected`, `disconnected` or `closed`, with
the last failure in `error`. `subscribe(callback)` reports it immediately and on
change. `connected()` waits for a connection across retries and rejects on
close (or on failure when retry is disabled). `reconnect()` cancels the current
attempt or connection and retries immediately.
