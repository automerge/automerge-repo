# Handle extensions

A handle extension lets a backend add its own methods and events to every
`DocHandle` of a Repo that uses it. For example, the Subduction backend uses one to give
handles ephemeral messaging: `handle.broadcast()` and the `ephemeral-message`
event. A backend with no extensions gives plain handles.

> **Experimental.** Names and types may change.

## How it Works

1. The backend lists its extensions on `handleExtensions`.
2. `new Repo({ backend })` adds their methods to every handle it gives out and types them accordingly
3. When app code calls an extension method, it has access to the backend and its document session.
4. The backend communicates with the handle by emitting `extension` events which the handle then routes internally.

## Writing an extension

This example is a cut-down version of Subduction's `ephemeral` extension. The
full version, with message validation, size limits and dropping a Repo's own
messages, is in `packages/automerge-repo-subduction/src/ephemeral.ts`.

### 1. Declare what the extension adds

A spec describes the extension: its kind, what its backend sends it, the
methods it adds to a handle and the events it emits:

```ts
interface EphemeralInbound {
  sender: string
  bytes: Uint8Array
}

interface EphemeralSpec {
  kind: "ephemeral"
  inbound: EphemeralInbound
  members: {
    /** Send a message to peers; best effort, not stored. */
    broadcast(message: unknown): void
  }
  events: {
    "ephemeral-message": { senderId: string; message: unknown }
  }
}
```

Leave `handle` out of event payloads: Repo adds it to each one, typed as the
extended handle.

### 2. Declare what the extension needs from the backend

This extension reaches its backend through the document's session. Declare
only the session methods it calls:

```ts
import type { SedimentreeSession } from "@automerge/automerge-repo/sedimentree"

interface EphemeralSession extends SedimentreeSession {
  publishEphemeral(bytes: Uint8Array): Promise<void>
}
```

We extend the base `SedimentreeSession` here, and then use this to describe the backend session later.

### 3. Define the extension

`defineExtension` builds the extension from plain functions. Each method
takes the document's context, then the handle it was called on, then the
caller's arguments.

```ts
import { decode, encode } from "cbor-x"
import { defineExtension } from "@automerge/automerge-repo/sedimentree"

export const ephemeral = defineExtension<EphemeralSession, EphemeralSpec>({
  kind: "ephemeral",
  // methods you would like to add to handles
  members: {
    broadcast(context, _handle, message) {
      const bytes = encode(message)
      // Nowhere to send once the document is closed.
      const { session } = context
      if (!session) return
      void (async () => {
        await session.publishEphemeral(bytes)
      })().catch(error => context.log("ephemeral publish failed: %o", error))
    },
  },
  // handle events received from the backend
  receive(context, { sender, bytes }) {
    context.emit("ephemeral-message", {
      senderId: sender,
      message: decode(bytes),
    })
  },
})
```

#### Document Context

- `documentId` and `repoId`.
- `sedimentreeId`: the document's ID as the backend knows it.
- `session`: the document's open session, or `undefined` once it has closed.
  Use this for best-effort work.
- `requireSession()`: the open session, or throws. Use this when a method only
  makes sense while the document is open.
- `emit(event, payload)`: emits on every handle of the document listening for
  `event`. Does nothing once the document is closed or deleted.
- `log(message, detail)`: logs an error and never throws.

### 4. List it on the backend

```ts
import {
  provides,
  type EventFor,
  type ExtensionsOf,
  type SedimentreeBackend,
  type SedimentreeId,
  type SessionFor,
} from "@automerge/automerge-repo/sedimentree"

// What the extensions add to handles; exported to type Repo later
export type MyExtensions = ExtensionsOf<MyBackend>
// The session `open()` returns: what the extensions need
export type MySession = SessionFor<MyBackend>
// The events the backend sends on its sessions
export type MyEvent = EventFor<MyBackend>

export class MyBackend implements SedimentreeBackend<MyExtensions> {
  // `provides` can be used to add one or more extensions
  readonly handleExtensions = provides(ephemeral)

  open(id: SedimentreeId): MySession {
    return {
      events: this.#eventsFor(id), // type as AsyncIterable<MyEvent> to type check events
      markReady: () => {},
      close: async () => {},
      // What `broadcast` on the handle calls on the backend session
      publishEphemeral: bytes => this.#send(id, bytes),
    }
  }
  // create, store, flush, deleteLocal, close, #eventsFor, #send …
}
```

### 5. Send events from the backend

When a message arrives for a document, put an `extension` event of the
extension's kind on that document's session event stream:

```ts
yield {
  type: "extension",
  sequence, // the stream's next sequence number
  // events are routed to the correct extension by `kind`
  kind: "ephemeral",
  payload: { sender, bytes },
}
```

Repo passes `payload` to that extension's `receive`.

Events can be type checked by ensuring your session event queue is properly typed with `MyEvent` (see section 4)

### The result

```ts
const repo = new Repo({ backend: new MyBackend() })
const handle = await repo.find<Doc>(url)

handle.broadcast({ cursor: 3 })
handle.on("ephemeral-message", ({ handle, senderId, message }) => {})
```

`repo` is a `Repo<MyExtensions>`, so `find()`, `create()`, `sub()`, `view()`
and Repo events all give handles with `broadcast` and `ephemeral-message`.

## Reaching the backend

There are two ways for an extension's methods to reach its backend.

**Through the session**, as above. Use this when the call
belongs to one open document. A session ends when its document closes or is
deleted, so the backend can refuse calls after that.

**Directly**, by defining the extension inside the backend class. Its methods
can then use `this`, private fields included, with nothing to declare:

```ts
interface PeersSpec {
  kind: "peers"
  members: { peers(): string[] }
}

class PeersBackend extends MemoryBackend {
  readonly handleExtensions = provides(
    defineExtension<SedimentreeSession, PeersSpec>({
      kind: "peers",
      members: { peers: context => this.#peersWith(context.sedimentreeId) },
    })
  )
  readonly #peers = new Map<SedimentreeId, Set<string>>()

  #peersWith(id: SedimentreeId): string[] {
    return [...(this.#peers.get(id) ?? [])]
  }
}

handle.peers() // peers the backend knows have this document
```

`context.sedimentreeId` tells the backend which document the call is for.

## Rules and Restrictions

- For now, at least, **add, don't replace.** An extension can't redefine a handle member
- **Unique `kind`** A Repo throws if two extensions share a `kind`.
