# Automerge Repo

Automerge Repo manages many [Automerge](https://github.com/automerge/automerge)
documents with pluggable persistence and synchronization backends.

This branch is an experimental backend proof of concept. Contracts and
integration behavior remain provisional; it is not a production-ready replacement
for the released adapter-based implementation.

## Development

Run `pnpm install`, then `pnpm build`. Use `pnpm dev` to watch packages and
`pnpm test` to run tests. The [React todo demo](./examples/react-todo/README.md)
runs with `pnpm dev:demo` after starting a local Subduction server.

## Packages

- [automerge-repo](./packages/automerge-repo/): Core Repo and DocHandle APIs.
- [automerge-repo-subduction](./packages/automerge-repo-subduction/): Subduction backend.
- [automerge-repo-react-hooks](./packages/automerge-repo-react-hooks/): React hooks.
- [automerge-react](./packages/automerge-react/): Convenience exports for Repo, React hooks and Subduction.
- [automerge-repo-svelte-store](./packages/automerge-repo-svelte-store/): Svelte stores.
- [automerge-repo-solid-primitives](./packages/automerge-repo-solid-primitives/): Solid primitives.

## Backend Migration

`Repo.create()` and `Repo.import()` return `Promise<DocHandle<T>>`.
`DocHandle.change()` applies edits immediately and returns a `Promise<void>`
for persistence. Await that promise to observe persistence failures.
`Repo.find()`, `flush()`, and `shutdown()` remain asynchronous.

Document bindings use `find()` for loading. Hooks retain deprecated
`findWithProgress().peek()` only where a synchronous initial value is needed.

Legacy network/storage adapter packages, their templates, and sync server have
been removed. The React umbrella and todo example now use Subduction instead of
legacy adapters. A legacy backend is deferred; the old adapter configuration is
not supported by this proof of concept.
