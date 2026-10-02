# Todo Demo

React todo list backed by the experimental Subduction backend and IndexedDB.
Tabs sync through the server, not BroadcastChannel. This demo uses open
authorization for trusted local development only.

Build the sibling Subduction checkout's `subduction_cli` and WASM runtime, then
start the server from that checkout:

```sh
./target/release/subduction_cli server \
  --socket 127.0.0.1:8080 \
  --service-name 127.0.0.1:8080 \
  --data-dir ./data-todo \
  --ephemeral-key --auth open --longpoll=false
```

From this workspace root:

```sh
pnpm install
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm --filter @automerge/automerge-repo-react-hooks build
pnpm --filter @automerge/react build
pnpm dev:demo
```

Add a todo, then open the same URL (including its hash) in another tab. Changes
arrive through Subduction over the server. You can override the endpoint with
`?server=ws://127.0.0.1:9090` before the hash. Existing documents also load
from the browser's `automerge-repo-demo-todo` IndexedDB database on reload,
including when the server is offline. New sessions use a fresh signer; durable
peer identity is not supplied by this demo.

**Storage warning:** multiple tabs share one IndexedDB database without
coordinated ownership. The backend requires exclusive storage access; concurrent
writes and deletes across tabs are not safe. This is a demo-only compromise, not
a supported multi-tab storage model. Keep the server running for cross-tab sync.
To reset local data, delete the `automerge-repo-demo-todo` database in DevTools.
