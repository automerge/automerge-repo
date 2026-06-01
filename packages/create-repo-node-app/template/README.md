# Automerge node app

A starter [Automerge](https://automerge.org) app for Node. It keeps a repo of
documents on the local filesystem and syncs them with a WebSocket sync server.

## Run

```sh
pnpm install
pnpm start
```

`pnpm start` runs `index.ts` directly using Node's built-in TypeScript support
(Node 22.18+), so there is no build step. Edit `index.ts` to build your app.

## Type-check

```sh
pnpm typecheck
```

## Lint

```sh
pnpm lint
```

Linting uses [oxlint](https://oxc.rs).
