# @automerge/vanillajs

A minimal vanilla JavaScript package for Automerge Repo that provides direct access to core types and adapters.

## Installation

```bash
npm install @automerge/vanillajs
# or
yarn add @automerge/vanillajs
# or
pnpm add @automerge/vanillajs
```

## Usage

```javascript
import {
  Repo,
  MessageChannelNetworkAdapter,
  IndexedDBStorageAdapter,
  WebSocketClientAdapter,
} from "@automerge/vanillajs"

// Create a repo with your chosen adapters
const repo = new Repo({
  network: [
    new MessageChannelNetworkAdapter(/* your message channel to another repo here */),
    new IndexedDBStorageAdapter(),
    new WebSocketClientAdapter("wss://sync.automerge.org"),
  ],
})

// Create a new document
const handle = repo.create()

// Load an existing document
const existingHandle = repo.find(documentId)

// Listen for changes
handle.on("change", () => {
  console.log("Document changed:", handle.docSync())
})
```

## Available Exports

### Core

- `Repo` - The main repository class
- `DocHandle` - Document handle type
- `DocumentId` - Document ID type

### Network Adapters

- `MessageChannelNetworkAdapter` - For communication between browser tabs
- `BroadcastChannelNetworkAdapter` - For communication between browser contexts
- `WebSocketClientAdapter` - For client-side WebSocket connections

### Storage Adapters

- `IndexedDBStorageAdapter` - For browser storage

## License

MIT
