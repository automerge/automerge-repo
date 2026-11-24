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
const counter = await repo.create(5, { docType: gcounter })
await counter.increment() // a member of the type
counter.doc() // 6
counter.url // "automerge:gcounter:…"

const same = await repo.find(counter.url, { docType: gcounter })
```

- The type is chosen per call, with `{ docType }` on `create`, `find`, `query`
  and `findWithProgress`. Without it you get Automerge.
- A type's `name` (lowercase letters, digits and `-`) is written in its URLs:
  `automerge:gcounter:<id>[#heads]`. Automerge's URLs stay
  `automerge:<id>[/path][#heads]`. `parseAutomergeUrl(url).docTypeName` reads
  the name; `isValidAutomergeUrl` checks the format only, for any type. `find`
  throws if a URL names another type, or if the document is already open as
  another type.
- `repo.handles` and the `document` event list every document, typed as a
  handle of any type (`DocHandle<any, X, AnyHandleKind>`). Narrow one with
  `isHandleOf(handle, gcounter)`.
- Every handle is typed `DocHandle<T, X, K>`: document shape `T`, backend
  extensions `X`, and the doc type's handles `K` (Automerge's by default).
  `DocHandle<T>` is the Automerge handle for documents shaped `T`; a counter's
  is `DocHandle<unknown, X, GCounter>`. `HandleOf<typeof repo, T, K>` names
  them from a Repo.
- A type whose handles are generic in the shape takes it with `of`:
  `repo.find(url, { docType: register.of<Todo>() })` gives
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
  readonly name: "gcounter"
  readonly handle: CounterHandle
}

export const gcounter = defineDocType({
  name: "gcounter",
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
given as `handle` and the type's `name`. Handles' URLs are typed with the
name: `counter.url` is `AutomergeUrl<"gcounter">`. `find`, `query` and
`findWithProgress` reject a typed URL of another doc type at compile time
(`find(counter.url)` needs `{ docType: gcounter }`); a plain `AutomergeUrl`,
such as a link read from a document, is only checked when opened.

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
`this["Shape"]` as the shape. It may also say what `create` takes for a shape.
Only shaped types have `of`:

```ts
export class RegisterHandle<T> extends Handle<T, T> {
  get<K extends keyof T>(key: K): T[K] {
    return this.doc()[key]
  }
}

export interface Register extends Shaped {
  readonly name: "register"
  readonly handle: RegisterHandle<this["Shape"]>
  readonly init: this["Shape"] // optional
}

export const register = defineDocType({ …, handle: RegisterHandle }).as<Register>()
```

Every handle gets the backend's members and events; a doc type never
mentions them. A method that returns a different handle (a handle for part of
the document, say) passes them on with `BackendOf<this>`:

```ts
// in AutomergeHandle<T>:
sub<K extends keyof T>(key: K): DocHandle<T[K], BackendOf<this>>
// in a handle class of your own, shown as DocHandle<…, X, MyKind>:
part<K extends keyof T>(key: K): DocHandle<T[K], BackendOf<this>, MyKind>
```

Handles are built by the Repo, never by apps: don't add constructor
parameters. Repo makes one subclass of the type's class per Repo, adding the
backend's extension members; a method of the same name as one of those
throws when the Repo first uses the type. `view()` returns `this`, so views
keep the class and the extensions.
