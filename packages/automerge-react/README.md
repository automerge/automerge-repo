# @automerge/react

A minimalist React package for Automerge Repo; does nothing but re-export other packages for your convenience.

## Installation

```bash
npm install @automerge/react
# or
yarn add @automerge/react
# or
pnpm add @automerge/react
```

## Usage

```tsx
import { createRepo, useDocument } from "@automerge/react"

// Create a pre-configured repo instance
const repo = createRepo({
  websocketUrl: "ws://localhost:8080", // optional
  enableStorage: true, // optional, defaults to true
  enableMessageChannel: true, // optional, defaults to true
})

// Use in your React components
function MyComponent() {
  const doc = useDocument(repo, "my-doc-id")

  if (!doc) return <div>Loading...</div>

  return <div>{doc.content}</div>
}
```

## Features

- Pre-configured Automerge Repo setup with common adapters
- Re-exports all React hooks from `@automerge/automerge-repo-react-hooks`
- TypeScript support
- Minimalist API surface

## API

### `createRepo(options?: CreateRepoOptions)`

Creates a pre-configured Automerge Repo instance with common adapters.

Options:

- `websocketUrl?: string` - The URL of the WebSocket server to connect to
- `enableStorage?: boolean` - Whether to enable IndexedDB storage (default: true)
- `enableMessageChannel?: boolean` - Whether to enable MessageChannel network adapter (default: true)

### Hooks

All hooks from `@automerge/automerge-repo-react-hooks` are re-exported:

- `useRepo`
- `useDocument`
- `useHandle`
- `useLocalAwareness`
- `useRemoteAwareness`
- `useBootstrap`
- `useSyncState`

## License

MIT
