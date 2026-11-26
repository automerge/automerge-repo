# Automerge Repo

> [!IMPORTANT]
> This branch is for the alpha of `automerge-repo` v3, APIs are reasonably
> stable but things will still change and there may be bugs (please tell us
> about them)

If you're coming from the v2 branch and wondering what's changed see [what
changed from v2](./packages/automerge-repo/README.md#breaking-changes-from-v2)
but the short version is that storage and networking is now managed by
[Subduction](./packages/automerge-repo-subduction/). This alpha currently doesn't
have a migration path from v2, but we will be adding one.

Automerge Repo manages many [Automerge](https://github.com/automerge/automerge)
documents at once, with pluggable persistence and synchronization.

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
- [automerge-react](./packages/automerge-react/): Repo and React hooks in one package.

#### Examples

- [react-todo](./examples/react-todo/): A React to-do list synced through Subduction.

## Development

```sh
pnpm install
pnpm build
pnpm test
pnpm --filter @automerge/automerge-repo-demo-todo dev # react-todo against the hosted Subduction server
```
