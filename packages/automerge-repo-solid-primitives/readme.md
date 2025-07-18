# Solid Automerge

<a href="https://www.solidjs.com/"> <img alt="" src=.assets/solid.png width=22
height=22> Solid </a> primitives for <a
href="https://automerge.org/docs/repositories/"> <img alt=""
src=.assets/automerge.png width=22 height=22>Automerge</a> .

```sh
pnpm add solidjs @automerge/automerge-repo
pnpm add solid-automerge
```

or, say:

```sh
deno add --npm solidjs @automerge/vanillajs
deno add jsr:@chee/solid-automerge
```

## useDocument ✨

Get a fine-grained live view of an automerge document from its URL.

When the handle receives changes, it converts the incoming automerge patch ops
to precise solid store updates, giving you fine-grained reactivity that's
consistent across space and time.

Returns `[doc, handle]`.

```ts
useDocument<T>(
    () => AutomergeURL,
    options?: {repo: Repo}
): [Doc<T>, DocHandle<T>]
```

```tsx
// example
const [url, setURL] = createSignal<AutomergeUrl>(props.url)
const [doc, handle] = useDocument(url, { repo })

const inc = () => handle()?.change(d => d.count++)
return <button onclick={inc}>{doc()?.count}</button>
```

The `{repo}` option can be left out if you are using [RepoContext](#repocontext).

## createDocumentProjection

Get a fine-grained live view from a signal automerge `DocHandle`.

Underlying primitive for [`useDocument`](#usedocument-).

Works with [`useHandle`](#usehandle).

```ts
createDocumentProjection<T>(() => AutomergeUrl): Doc<T>
```

```tsx
// example
const handle = repo.find(url)
const doc = makeDocumentProjection<{ items: { title: string }[] }>(handle)

// subscribes fine-grained to doc.items[1].title
return <h1>{doc.items[1].title}</h1>
```

## makeDocumentProjection

Just like `createDocumentProjection`, but without a reactive input.

Underlying primitive for [`createDocumentProjection`](#createDocumentProjection).

```ts
makeDocumentProjection<T>(handle: Handle<T>): Doc<T>
```

```tsx
// example
const handle = repo.find(url)
const doc = makeDocumentProjection<{ items: { title: string }[] }>(handle)

// subscribes fine-grained to doc.items[1].title
return <h1>{doc.items[1].title}</h1>
```

## useDocHandle

Get a [DocHandle](https://automerge.org/docs/repositories/dochandles/) from the
repo as a
[resource](https://docs.solidjs.com/reference/basic-reactivity/create-resource).

Perfect for handing to `createDocumentProjection`.

```ts
useDocHandle<T>(
    () => AnyDocumentId,
    options?: {repo: Repo}
): Resource<Handle<T>>
```

```tsx
const handle = useDocHandle(id, { repo })
// or
const handle = useDocHandle(id)
```

The `repo` option can be left out if you are using [RepoContext](#repocontext).

## context

If you prefer the context pattern for some reason, you can pass the repo higher
up in your app with `RepoContext`

### `RepoContext`

A convenience context for Automerge-Repo Solid apps. Optional: if you prefer you
can pass a repo as an option to `useDocHandle` and `useDocument`.

```tsx
<RepoContext.Provider repo={Repo}>
  <App />
</RepoContext.Provider>
```

### `useRepo`

Get the repo from the [context](#repocontext).

```ts
useRepo(): Repo
```

#### e.g.

```ts
const repo = useRepo()
```
