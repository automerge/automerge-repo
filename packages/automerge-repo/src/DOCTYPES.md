# Document types

A document type tells a Repo how to store, read and change one kind of
document. Automerge is the default type (`automerge`), but any document that can
be represented as a sedimentree can be defined as a docType.

> **Alpha.** Names and types may change.

## How it works

1. Define the doc type with `defineDocType` and give it a URL `scheme`.
2. Callers pass `{ docType }` to `repo.create`, `repo.find` or `repo.query`
   (without it they get Automerge).
3. Each document's URL starts with that scheme (`gcounter:<id>`).
4. Repo converts the document's history into sedimentree records and stores and
   syncs them through the backend, which stays doc-type-agnostic.

## Writing a doc type

This example is a grow-only counter (`gcounter`). The full implementation,
including the plain-JS commit graph it builds on, is in
`packages/automerge-repo/test/doctypes/gcounter/` and
`packages/automerge-repo/test/doctypes/common/commitGraph.ts`.

### 1. Define the doc type

```ts
import { defineDocType } from "@automerge/automerge-repo"

export const gcounter = defineDocType({
  scheme: "gcounter", // URL prefix before `:` (`gcounter:<id>`)
  create: (start: number | undefined) => newCounter(start), // new state (>= 1 commit); also gets `{ repoId }`
  value: (state: CounterState) => sum(state), // what `handle.doc()` returns
  change: (state: CounterState, amount: number) => add(state, amount), // local edit; also gets `{ documentId, repoId }`
  apply: (state, records) => applyCommits(state, records), // apply records to state(`undefined` on first load; `[]` = empty)
  heads: state => headsOf(state), // current applied heads
  hasHeads: (state, heads) => heads.every(h => isApplied(state, h)), // true if all heads are applied (not pending)
  recordsSince: (state, heads) => commitsSince(state, heads), // records since `heads`

  // Optional:
  view: (state, heads) => stateAt(state, heads), // read-only state at `heads`
  // merge: (state, other) => ..., // defaults to applying `other`'s records
  // fragments: (state, heads) => ..., // `{ records, absent }` for storage compaction
  // handle: CounterHandle, // custom handle class (step 2)
  // openUrl / formatUrl // custom URL format (see below)
})
```

`state` is the document's underlying CRDT or data structure (an `A.Doc` for
Automerge, or a `CounterState` commit graph for `gcounter`). Repo holds one
`state` per open document, which can be immutable or mutated in place.
See `DocType` in `packages/automerge-repo/src/DocType.ts` for full field signatures and
contracts.

### 2. Optional: add a handle class

Without a handle class, callers use `handle.doc()` and `handle.change(...)`. To
add type-specific methods, subclass `Handle<View, Change>` and pass it as
`handle`:

```ts
import { Handle } from "@automerge/automerge-repo"

export class CounterHandle extends Handle<number, number> {
  increment(amount = 1) {
    return this.change(amount)
  }
}
```

### 3. Optional: name the handles

Declare an interface extending `HandleKind` and pass it to `.as<...>()` to give
handles a named `DocHandle` type. Sharing `scheme` as a constant keeps the
runtime string and type in sync:

```ts
import { defineDocType, type HandleKind } from "@automerge/automerge-repo"

const scheme = "gcounter"

export interface GCounter extends HandleKind {
  readonly scheme: typeof scheme
  readonly handle: CounterHandle
}

export const gcounter = defineDocType({
  scheme,
  // create, value, change, apply, heads, hasHeads, recordsSince, view …
  handle: CounterHandle,
}).as<GCounter>() // rejects a scheme or handle class mismatch
```

### 4. Test it

Run `runDocTypeTests`
(`packages/automerge-repo/src/helpers/tests/doc-type-tests.ts`) against your doc
type to check the storage, ordering, replay and sync contract.

### The result

```ts
import { isHandleOf, Repo } from "@automerge/automerge-repo"
import { gcounter } from "./gcounter.js"

const repo = new Repo()
const counter = await repo.create(5, { docType: gcounter })
await counter.increment()
counter.doc() // 6
counter.url // "gcounter:…" (typed as DocumentUrl<"gcounter">)

const same = await repo.find(counter.url, { docType: gcounter })

// repo.handles and the "document" event list every type; narrow with isHandleOf
repo.on("document", ({ handle }) => {
  if (isHandleOf(handle, gcounter)) {
    handle.doc() // number
  }
})
```

The React hooks, Svelte stores and Solid primitives take `{ docType }` as
`find` does, and default to Automerge.

## Handles generic in the document's shape

If your handle class is generic, extend `Shaped` instead of `HandleKind` and
refer to the document type parameter as `this["Shape"]`.

`.as<...>()` can then be called on the definition to add `.of<T>()` to the doc type
which is used to add your document shape to the type when using `create`, `find` etc.

```ts
import { defineDocType, Handle, type Shaped } from "@automerge/automerge-repo"

export class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K] {
    return this.doc()[key]
  }
}

export interface Register extends Shaped {
  readonly scheme: "register"
  readonly handle: RegisterHandle<this["Shape"]> // `this["Shape"]` = `T` passed to `.of<T>()`
  readonly init: this["Shape"] // optional: types the initial value in `repo.create()`
}

export const register = defineDocType({
  scheme: "register",
  // …
  handle: RegisterHandle,
}).as<Register>() // adds `.of<T>()` to `register`

const handle = await repo.find(url, { docType: register.of<Todo>() }) // sets `this["Shape"]` to `Todo`
handle.get("title") // typed as `Todo["title"]`
```

## Custom `change` event payloads

By default, every writable handle with a `change` listener receives
`{ handle, doc }`. A handle subclass can override
`protected changeEventPayload(change)` to add fields (as Automerge does with
`patches` and `patchInfo`) or return `undefined` to skip emitting an event.

It runs only when the handle is writable and has a `change` listener. `change`
is a `StateChange<State>` (`before`, `beforeHeads`, `after`, `afterHeads`),
where `before` is `undefined` on first load and may equal `after` if the type
mutates state in place.

## Custom URL formats

Only `<scheme>:` is fixed across doc types. By default, URLs are
`<scheme>:<base58DocumentId>`. To define your own URL format (for versions,
paths or query parameters), implement `openUrl(url)` and `formatUrl(handle)`:

```ts
formatUrl(handle) {
  const path = handle.section ? `/${handle.section}` : ""
  const query = handle.isReadOnly() ? `?at=${handle.heads().join(",")}` : ""
  return `notes://v1/${handle.documentId}${path}${query}`
},
openUrl(url) {
  const m = url.match(/^notes:\/\/v1\/([^/?]+)(?:\/([^?]+))?(?:\?(.*))?$/)
  if (!m) throw new Error(`Invalid notes URL: ${url}`)
  const [, id, section, query] = m
  const at = new URLSearchParams(query ?? "").get("at")
  return {
    documentId: id as DocumentId,
    heads: at ? (at.split(",") as UrlHeads) : undefined,
    // Apply extra URL params once the root (or view) handle is ready
    open: section ? handle => handle.at(section) : undefined,
  }
},
```

- `openUrl(url)` returns `{ documentId, heads?, open? }`: `heads` waits for
  those heads and opens a view; `open(handle)` applies any extra URL params once
  ready (the returned handle must keep the same `documentId` and stay read-only
  if `handle` is a view).
- `openUrl` runs synchronously in `repo.query` before the document is opened,
  so invalid URLs fail immediately without opening a backend session.
- `formatUrl(handle)` must return a URL starting with `<scheme>:`.
- When using a custom URL format, pass `{ docType }` to
  `repo.delete(url, { docType })`, `parseDocumentUrl(url, docType)`,
  `isValidDocumentUrl(url, docType)` and `interpretAsDocumentId(url, docType)`.

## Rules and restrictions

- **Schemes and URL checks.** A scheme must start with a lowercase letter
  followed by lowercase letters, digits, `+`, `.` or `-`. `find` and `query`
  reject typed URLs of another scheme at compile time and throw at runtime if a
  URL's scheme or an already-open document disagrees with `docType`.
- **`apply` contract.** `apply` must hold commits whose parents are missing and
  apply them once their parents arrive, and must produce the same state if
  records arrive twice or out of order.
- **Handle classes.** Handles should only be built by Repo, so do not add
  constructor parameters. A handle method whose name clashes with a backend
  extension throws when the Repo first uses the type.
- **Automerge only on `Repo`.** `repo.clone`, `repo.import`, `repo.export`, and
  `repo.metrics` (which skips other types). `handle.merge` works for every type.
