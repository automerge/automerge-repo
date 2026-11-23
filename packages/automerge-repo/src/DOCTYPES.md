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
  handle of any type (`DocHandle<any, X, AnyHandleKind>`). Narrow one with
  `isHandleOf(handle, gcounter)`.
- Every handle is typed `DocHandle<T, X, K>`: document shape `T`, backend
  extensions `X`, and the doc type's handles `K` (Automerge's by default).
  `DocHandle<T>` is the Automerge handle for documents shaped `T`; a counter's
  is `DocHandle<unknown, X, GCounter>`. `HandleOf<typeof repo, T, K>` names
  them from a Repo.
- A type whose handles are generic in the shape takes it with `of`:
  `repo.find(url, { type: register.of<Todo>() })` gives
  `DocHandle<Todo, X, Register>`. `of` is type-level only; every shape is the
  same doc type at runtime. `automerge.of<Todo>()` is the same as
  `find<Todo>(url)`.
- `clone`, `import`, `export` and URL paths (sub-handles) are Automerge only.

## What every handle has

`documentId`, `url`, `isReady`, `isDeleted`, `isReadOnly`, `doc`, `heads`,
`hasHeads`, `view` (if the type has views), `change`, `merge`, `delete`,
`getSyncInfo`, `equals`, the listener methods, and the events `change`
(`{ handle, doc }`), `heads-changed`, `delete` and `remote-heads`. Backend
extensions add their members to every handle, whatever its type.

## Writing one

A type is its storage rules plus, optionally, a handle class: a subclass of
`Handle<View, Change>` with the type's reading and editing API, and one
interface saying what its handles are, which also names the type.

```ts
import {
  defineDocType,
  Handle,
  type HandleKind,
} from "@automerge/automerge-repo"

export class CounterHandle extends Handle<number, number> {
  increment(amount = 1) {
    return this.change(amount)
  }
}

export interface GCounter extends HandleKind {
  readonly handle: CounterHandle
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
}).as<GCounter>() // optional; without it, handles show the class's name
```

`defineDocType` checks that the class's `Handle<View, Change>` matches the
type's `value` and `change`, and `as` that the interface names the class
given as `handle`.

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
handle class is generic extends `Shaped` instead, naming the class with
`this["T"]` as the shape. It may also say what `create` takes for a shape.
Only shaped types have `of`:

```ts
export class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K] {
    return this.doc()[key]
  }
}

export interface Register extends Shaped {
  readonly handle: RegisterHandle<this["T"]>
  readonly init: this["T"] // optional
}

export const register = defineDocType({ …, handle: RegisterHandle }).as<Register>()
```

A method that returns a different handle (a handle for part of the document,
say) types it as `SameBackend<this, MyHandle<T[K]>>`, so the result keeps the
backend's members and events. Or, like Automerge, the class takes the backend's
spec as a second parameter, and the interface passes it on as `this["X"]`:

```ts
interface AutomergeKind extends Shaped {
  readonly handle: AutomergeHandle<this["T"], this["X"]>
}
// in AutomergeHandle<T, X>:
sub<K extends keyof T>(key: K): DocHandle<T[K], X>
```

Handles are built by the Repo, never by apps: don't add constructor
parameters. Repo makes one subclass of the type's class per Repo, adding the
backend's extension members; a method of the same name as one of those
throws when the Repo first uses the type. `view()` returns `this`, so views
keep the class and the extensions.
