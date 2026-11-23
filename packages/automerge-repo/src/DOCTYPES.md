# Document types

A document type tells a Repo how to store, read and change one kind of
document. Automerge is the default type (`automerge`); anything whose history
is a graph of commits can be another. Every handle is a `DocHandle`, whatever
its type.

## Using one

```ts
import { Repo } from "@automerge/automerge-repo"
import { gcounter } from "./gcounter.js"

const repo = new Repo()
const counter = await repo.create(5, { type: gcounter })
await counter.increment() // a member of the type
counter.doc() // 6
counter.url // "gcounter:…"

const same = await repo.find(counter.url, { type: gcounter })
```

- The type is chosen per call, with `{ type }` on `create`, `find`, `query`
  and `findWithProgress`. Without it you get Automerge.
- A type's `scheme` names it in URLs. `find` throws if a URL's scheme does not
  match the type, or if the document is already open as another type.
- `repo.handles` and the `document` event list every document, typed as a
  handle of any type (`DocHandle<any, X, AnyDocType>`). Narrow one with
  `isHandleOf(handle, gcounter)`.
- Every handle is typed `DocHandle<T, X, D>`: document shape `T`, backend
  extensions `X`, doc type `D` (Automerge by default). `DocHandle<T>` is the
  Automerge handle for documents shaped `T`; a counter's is
  `DocHandle<unknown, X, typeof gcounter>`. `HandleOf<typeof repo, T, D>`
  names them from a Repo.
- A type whose handles are generic in the shape takes it with `of`:
  `repo.find(url, { type: register.of<Todo>() })` gives
  `DocHandle<Todo, X, typeof register>`. `of` is type-level only; every shape
  is the same doc type at runtime.
- `clone`, `import`, `export` and URL paths (sub-handles) are Automerge only.

## What every handle has

`documentId`, `url`, `isReady`, `isDeleted`, `isReadOnly`, `doc`, `heads`,
`hasHeads`, `view` (if the type has views), `change`, `merge`, `delete`,
`getSyncInfo`, `equals`, the listener methods, and the events `change`
(`{ handle, doc }`), `heads-changed`, `delete` and `remote-heads`. Backend
extensions add their members to every handle, whatever its type.

## Writing one

A type is its storage rules plus, optionally, a handle class: a subclass of
`Handle` with the type's reading and editing API.

```ts
import { defineDocType, Handle } from "@automerge/automerge-repo"

export class CounterHandle extends Handle<number, number> {
  increment(amount = 1) {
    return this.change(amount)
  }
}

export const gcounter = defineDocType({
  scheme: "gcounter",
  create: (start: number | undefined) => newCounter(start), // ≥ 1 commit
  value: (state: CounterState) => sum(state), // what doc() returns
  change: (state: CounterState, amount: number) => add(state, amount),
  apply: (state, records) => applyCommits(state, records),
  heads: state => headsOf(state),
  hasHeads: (state, heads) => heads.every(h => isApplied(state, h)),
  recordsSince: (state, heads) => commitsOutside(state, heads),
  view: (state, heads) => stateAt(state, heads), // optional
  handle: CounterHandle, // optional; defaults to Handle<View, Change>
})
```

The contract, checked by `runDocTypeTests` (`src/helpers/tests/doc-type-tests.ts`):

- Heads and commit IDs are 64 lowercase hex characters; every head is a commit.
- `apply` keeps commits whose parents are missing and applies them once the
  parents arrive; `hasHeads` does not count those pending commits.
- Applying the same records twice, or in another order, gives the same state.
- `recordsSince(state, [])` is the whole history; with heads, only the commits
  outside them. `apply(undefined, [])` is an empty state.
- State may be changed in place: Repo reads heads before each change and never
  keeps an old state.
- Without `fragments`, a type is never compacted; without `view`, it has no
  views and no `find(url#heads)`; without `merge`, merging applies the other
  document's records.

### Handles generic in the document's shape

TypeScript can't apply a shape to a class held in a value, so a type whose
handle class is generic says how, with one interface naming the class with
`this["T"]` as the shape. It may also say what `create` takes for a shape:

```ts
export class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K] {
    return this.doc()[key]
  }
}

interface RegisterShaped extends Shaped {
  readonly handle: RegisterHandle<this["T"]>
  readonly init: this["T"] // optional
}

export const register = defineDocType({ …, handle: RegisterHandle })
  .shaped<RegisterShaped>()
```

A method that returns a different handle (a handle for part of the document,
say) types it as `SameBackend<this, MyHandle<T[K]>>`, so the result keeps the
backend's members and events. Automerge's `sub` does.

Handles are built by the Repo, never by apps: don't add constructor
parameters. Repo makes one subclass of the type's class per Repo, adding the
backend's extension members; a method of the same name as one of those
throws when the Repo first uses the type. `view()` returns `this`, so views
keep the class and the extensions.
