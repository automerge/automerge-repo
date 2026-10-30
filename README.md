# Automerge Repo

Automerge Repo manages many [Automerge](https://github.com/automerge/automerge)
documents at once, with pluggable persistence and synchronization.

> **Alpha.** v3 replaces v2's network and storage adapters with a single
> _backend_, [Subduction](./packages/automerge-repo-subduction/). APIs may
> still change. See [what changed from v2](./packages/automerge-repo/README.md#breaking-changes-from-v2).

## Packages

- [automerge-repo](./packages/automerge-repo/): The core `Repo` and `DocHandle`. Start here.

#### Subduction backend

- [automerge-repo-subduction](./packages/automerge-repo-subduction/): The backend.
- [automerge-repo-subduction-storage-indexeddb](./packages/automerge-repo-subduction-storage-indexeddb/):
  Browser storage.
- [automerge-repo-subduction-network-websocket](./packages/automerge-repo-subduction-network-websocket/):
  WebSocket client.

#### Front-end bindings

- [automerge-repo-react-hooks](./packages/automerge-repo-react-hooks/): React hooks.
- [automerge-repo-svelte-store](./packages/automerge-repo-svelte-store/): Svelte stores.
- [automerge-repo-solid-primitives](./packages/automerge-repo-solid-primitives/): Solid primitives.
- [automerge-react](./packages/automerge-react/): Repo, React hooks and Subduction in one package.

#### Examples

- [react-todo](./examples/react-todo/): A React to-do list synced through Subduction.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm dev:demo # react-todo against the hosted Subduction server
```
