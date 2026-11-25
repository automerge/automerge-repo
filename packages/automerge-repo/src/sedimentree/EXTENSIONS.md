# Handle extensions

A handle extension lets a backend add its own methods and events to every
`DocHandle` of a Repo that uses it, regardless of its [document type](../DOCTYPES.md).
For example, the Subduction backend uses one to give handles ephemeral
messaging: `handle.broadcast()` and the `ephemeral-message` event. A backend
with no extensions gives plain handles.

> **Beta.** Names and types may change.

## How it Works

1. The backend lists its extensions on `handleExtensions`.
2. `new Repo({ backend })` adds their methods to every handle it gives out and types them accordingly
3. When app code calls an extension method, it has access to the backend and its document session.
4. The backend communicates with the handle by emitting `extension` events, which Repo routes to the extension receiving that kind.

## Writing an extension

This example is a cut-down version of Subduction's `ephemeral` extension. The
full version, with message validation, size limits and dropping a Repo's own
messages, is in `packages/automerge-repo-subduction/src/ephemeral.ts`.

### 1. Declare the extension's spec

A spec describes the extension. Each part is optional:

- `session`: what it needs of the document's session. Extend the base
  `SedimentreeSession` with only the methods it calls.
- `receives`: the payloads its backend sends it, by kind.
- `members`: the methods it adds to a handle.
- `events`: the payloads of the events it emits on handles, by name.

```ts
import type { SedimentreeSession } from "@automerge/automerge-repo/sedimentree"

interface EphemeralSession extends SedimentreeSession {
  publishEphemeral(bytes: Uint8Array): Promise<void>
}

interface EphemeralSpec {
  session: EphemeralSession
  receives: {
    ephemeral: { sender: string; bytes: Uint8Array }
  }
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

### 2. Define the extension

`defineExtension` checks plain functions against the spec. Each method
takes the document's context, then the handle it was called on, then the
caller's arguments. `receive` has one function for each kind in `receives`.
Both `members` and `receive` should be plain objects.

```ts
import { decode, encode } from "cbor-x"
import { defineExtension } from "@automerge/automerge-repo/sedimentree"

export const ephemeral = defineExtension<EphemeralSpec>({
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
  // handle events received from the backend, by kind
  receive: {
    ephemeral(context, { sender, bytes }) {
      context.emit("ephemeral-message", {
        senderId: sender,
        message: decode(bytes),
      })
    },
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

### 3. List it on the backend

```ts
import {
  provides,
  type EventFor,
  type ExtensionsOf,
  type SedimentreeBackend,
  type SedimentreeId,
  type SessionFor,
} from "@automerge/automerge-repo/sedimentree"

// The backend's spec, its extensions' combined; exported to type Repo later
export type MyExtensions = ExtensionsOf<MyBackend>
// The session `open()` returns: what the extensions need
export type MySession = SessionFor<MyBackend>
// The events the backend sends on its sessions
export type MyEvent = EventFor<MyBackend>

export class MyBackend implements SedimentreeBackend {
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

### 4. Send events from the backend

When a message arrives for a document, put an `extension` event of a kind
the extension receives on that document's session event stream:

```ts
yield {
  type: "extension",
  sequence, // the stream's next sequence number
  // events are routed to the extension receiving this `kind`
  kind: "ephemeral",
  payload: { sender, bytes },
}
```

Repo passes `payload` to that extension's `receive.ephemeral`.

Events can be type checked by ensuring your session event queue is properly typed with `MyEvent` (see section 3)

### The result

```ts
const repo = new Repo({ backend: new MyBackend() })
const handle = await repo.find<Doc>(url)

handle.broadcast({ cursor: 3 })
handle.on("ephemeral-message", ({ handle, senderId, message }) => {})
```

`repo` is a `Repo<MyExtensions>`, so `find()`, `create()`, `view()`, `sub()`
(for Automerge) and Repo events all give handles with `broadcast` and
`ephemeral-message`, for every document type.

## Reaching the backend

There are two ways for an extension's methods to reach its backend.

**Through the session**, as above. Use this when the call
belongs to one open document. A session ends when its document closes or is
deleted, so the backend can refuse calls after that.

**Directly**, by defining the extension inside the backend class. Its methods
can then use `this`, private fields included, with nothing to declare:

```ts
interface PeersSpec {
  members: { peers(): string[] }
}

class PeersBackend extends MemoryBackend {
  readonly handleExtensions = provides(
    defineExtension<PeersSpec>({
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

## Typing against the calling handle

A method whose return type depends on the handle it is called on takes that
type from `this` in the spec. Using `H extends AnyDocHandle` works across every
document type and keeps the handle's extensions:

```ts
import type { AnyDocHandle, UrlHeads } from "@automerge/automerge-repo"

interface BookmarkSession extends SedimentreeSession {
  findBookmark(label: string): Promise<UrlHeads | undefined>
}

interface BookmarkSpec {
  session: BookmarkSession
  members: {
    /** A view of the document where the backend bookmarked `label`. */
    openBookmark<H extends AnyDocHandle>(
      // `this` is TypeScript-only, and is erased at runtime
      this: H,
      label: string
    ): Promise<H | undefined>
  }
}

const bookmarks = defineExtension<BookmarkSpec>({
  members: {
    // note `label` is passed here, but not `this`
    async openBookmark(context, handle, label) {
      const heads = await context.requireSession().findBookmark(label)
      return heads && handle.view(heads)
    },
  },
})

await handle.openBookmark("v1") // keeps the Automerge handle type and extensions
await handle.sub("title").openBookmark("v1") // keeps the sub-handle type
await counter.openBookmark("v1") // works on non-Automerge doc types too
```

If a method only applies to Automerge handles and needs the document's shape
`T`, declare `this: DocHandle<T>` instead; calling it on a non-Automerge
handle is then a type error.

## Rules and Restrictions

- For now, at least, **add, don't replace.** An extension can't redefine a
  handle member, and a doc type's handle class can't clash with an extension
  member name.
- **Unique kinds** A Repo throws if two extensions receive the same kind.
