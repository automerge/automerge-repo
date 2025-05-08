# Svelte store for Automerge Repo

A reactive Svelte store for Automerge documents. Compatible with Svelte 3, 4, and 5.

## Installation

```bash
npm install @automerge/automerge-repo-svelte-store
```

## Example Usage

### Basic Usage

```svelte
<script>
  import { Repo } from "@automerge/automerge-repo"
  import { createAutomergeStore } from "@automerge/automerge-repo-svelte-store"

  // Create a repo
  const repo = new Repo({
    // Configuration...
  })

  // Create a store from the repo
  const automergeStore = createAutomergeStore(repo)

  // Load or create a document
  let documentStore = null

  async function loadDocument(url) {
    documentStore = await automergeStore.find(url)
  }

  async function createDocument() {
    documentStore = await automergeStore.create({ count: 0 })
  }

  // Update the document
  function incrementCounter() {
    if (documentStore) {
      documentStore.change(doc => {
        doc.count = (doc.count || 0) + 1
      })
    }
  }
</script>
```

### Using with Svelte Context (recommended)

```svelte
<!-- App.svelte -->
<script>
  import { Repo } from "@automerge/automerge-repo"
  import { setContextRepo } from "@automerge/automerge-repo-svelte-store"
  import Counter from './Counter.svelte'

  const repo = new Repo({
    // Configuration...
  })

  // Make repo available to child components
  setContextRepo(repo)

  // Create a document asynchronously
  let docUrl = null

  async function setupDoc() {
    const handle = await repo.create({ count: 0 })
    docUrl = handle.url
  }

  setupDoc()
</script>

{#if docUrl}
  <Counter {docUrl} />
{:else}
  <p>Creating document...</p>
{/if}
```

```svelte
<!-- Counter.svelte -->
<script>
  import { document } from "@automerge/automerge-repo-svelte-store"
  import { onMount } from "svelte"

  export let docUrl

  // The document store - initially null
  let docStore = null

  // Load the document on mount
  onMount(async () => {
    // document() is async and returns a Promise
    docStore = await document(docUrl)
  })

  function increment() {
    if (!docStore) return

    // Access the document using the Svelte store $ syntax
    docStore.change(doc => {
      doc.count = (doc.count || 0) + 1
    })
  }
</script>

{#if docStore}
  <button on:click={increment}>
    Count: {$docStore.count || 0}
  </button>
{:else}
  <p>Loading document...</p>
{/if}
```

### Using with Svelte 5 Runes

With Svelte 5, you can use the store with runes syntax for a more ergonomic experience:

```svelte
<script>
  import { document } from "@automerge/automerge-repo-svelte-store"

  export let docUrl

  // Initialize state
  let docStore = $state(null)
  let loading = $state(true)
  let error = $state(null)
  let count = $derived(docStore?.$doc?.count || 0)

  // Load document when component initializes
  $effect(() => {
    async function loadDocument() {
      try {
        loading = true
        docStore = await document(docUrl)
        loading = false
      } catch (err) {
        console.error("Failed to load document:", err)
        error = err
        loading = false
      }
    }

    loadDocument()
  })

  function increment() {
    if (docStore) {
      docStore.change(doc => {
        doc.count = (doc.count || 0) + 1
      })
    }
  }
</script>

{#if loading}
  <p>Loading document...</p>
{:else if error}
  <p>Error: {error.message}</p>
{:else}
  <button on:click={increment}>
    Count: {count}
  </button>
{/if}
```

## API Reference

### `createAutomergeStore(repo)`

Creates an Automerge store factory from a repo instance.

### `setContextRepo(repo)`

Sets the Automerge repo in the current component's context.

### `getContextRepo()`

Gets the Automerge repo from the current component's context.

### `document(docIdOrUrl, repoInstance?)`

Convenience method to load a document from the repo in context or a provided repo.
**Important:** This function returns a Promise that resolves to the document store.

## Store API

The document store returned by `find()` and `create()` implements Svelte's writable store contract with these additional methods:

- `change(fn)`: Make changes to the document
- `url`: Get the document URL
- `documentId`: Get the document ID
- `handle`: Access the underlying Automerge document handle

## Contributors

Originally written by Dylan MacKenzie (@ecstatic-morse).
Updated for Svelte 5 compatibility by the Automerge team.
