# Automerge + Vite + React

A starter app built with [Automerge](https://automerge.org),
[Vite](https://vite.dev), and React. State is a local-first Automerge document
that syncs peer-to-peer over a WebSocket sync server and across browser tabs.

## Develop

```sh
pnpm install
pnpm dev
```

Open the app in two tabs (or share the URL, including its `#…` document hash)
and watch the counter synchronize in real time.

## Build

```sh
pnpm build
```

The static site is emitted to `dist/`.

## Lint

```sh
pnpm lint
```

Linting uses [oxlint](https://oxc.rs).

## Deploy

A GitHub Pages workflow is included at `.github/workflows/deploy.yml`. If you
deploy to a project page (`https://<user>.github.io/<repo>/`), set `base` in
`vite.config.ts` to `"/<repo>/"`.
