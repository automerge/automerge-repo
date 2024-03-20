# Svelte store for Automerge Repo

## Example Usage

For a working example, see the [Svelte counter demo](../automerge-repo-demo-counter-svelte/).

`App.svelte`

```svelte
<script lang="ts">
  import { Repo } from "@automerge/automerge-repo"
  import Counter from './lib/Counter.svelte'
  import { setContextRepo } from "@automerge/automerge-repo-svelte-store"

  const repo = new Repo({ /* repo config */ })

  // Make the `Repo` available to child components (via Svelte's `setContext`).
  setContextRepo(repo)

  const docId = repo.create()
</script>

<main>
  <div class="card">
    <Counter {docId}/>
  </div>
</main>
```

`Counter.svelte`

```svelte
<script lang="ts">
  import type { DocumentId } from "@automerge/automerge-repo"
  import { document } from "@automerge/automerge-repo-svelte-store"

  export let docId: DocumentId

  // `document` calls `getContextRepo` internally to access the closest `Repo`.
  // alternatively, you may pass in a specific repo as the second parameter
  const doc = document<{count?: number}>(docId)
  const increment = () => {
    doc.change((d) => d.count = (d.count || 0) + 1)
  }
</script>

<button on:click={increment}>
  count is {$doc?.count || 0}
</button>
```

## Contributors

Originally written by Dylan MacKenzie ([@ecstatic-morse](https://github.com/ecstatic-morse)).
