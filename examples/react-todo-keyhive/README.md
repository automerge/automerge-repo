# Keyhive Todo Demo

A fork of [`react-todo`](../react-todo) on `KeyhiveBackend`. The content is
end-to-end encrypted, and access is managed from the browser console.

Each todo is its own document. So that sharing the list also shares its items,
every list has a keyhive _group_. The list and each new todo grant the group,
and `kh.share(...)` adds people to the group.

## Run

Start a local Subduction server. The demo derives the server's verifying key
from `--key-seed 07…07` by default:

```sh
cargo run -p subduction_cli -- server \
  --socket 127.0.0.1:8080 \
  --service-name 127.0.0.1:8080 \
  --key-seed 0707070707070707070707070707070707070707070707070707070707070707
```

`--service-name` must match the host in the demo's `?server=` URL. Clients use
it as the handshake audience, and the server rejects a mismatch with
`challenge validation failed: invalid audience`.

If the server has another key (for example `--ephemeral-key`), give the demo
the server's peer ID from its log with `?relay=<hex>`.

From this workspace root:

```sh
pnpm install
pnpm --filter @automerge/automerge-repo build
pnpm --filter @automerge/automerge-repo-subduction build
pnpm --filter @automerge/automerge-repo-subduction-keyhive build
pnpm --filter @automerge/automerge-repo-subduction-network-websocket build
pnpm --filter @automerge/automerge-repo-subduction-storage-indexeddb build
pnpm --filter @automerge/automerge-repo-react-hooks build
pnpm --filter @automerge/react build
pnpm --filter @automerge/automerge-repo-demo-todo-keyhive dev
```

## Query parameters

| Parameter | Default               | Meaning                                                   |
| --------- | --------------------- | --------------------------------------------------------- |
| `as`      | random `tab-xxxx`     | Replica name: its own IndexedDB, signing key and keyhive  |
| `log`     | `warn`                | Keyhive log level                                         |
| `relay`   | key of seed `07…07`   | The server's verifying key (hex), granted Relay           |
| `server`  | `ws://127.0.0.1:8080` | Subduction server URL                                     |

## Try it

1. Open `http://localhost:5173/?as=alice`. A new list is created, and its URL
   goes into the hash.
2. In another tab, open `?as=bob` with _the same hash_. Bob waits for access.
3. In Alice's console:

   ```js
   kh.peers                  // { bob: "<contact card>" }, found over BroadcastChannel
   await kh.share("bob")     // or kh.share("bob", "read")
   ```

4. Bob's tab loads the list. Edits from either tab sync through the server.
5. Revoke with `await kh.revoke("bob")`. New writes from Alice stay pending at
   Bob (`kh.pending()`).

Run `kh.help()` for the full list. To share with another browser, paste
`await kh.card()` from that browser into `kh.share(card)`.

> [!WARNING]
> IndexedDB holds the signing key and prekey secrets unencrypted. This demo is
> for local experiments only. To reset, delete the
> `automerge-repo-demo-todo-keyhive-<name>` databases in DevTools.
