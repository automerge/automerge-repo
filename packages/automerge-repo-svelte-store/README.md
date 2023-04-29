# Svelte store for Automrege Repo

## Example Usage

For a working example, see the [Svelte counter demo](../automerge-repo-demo-counter-svelte/).

`App.svelte`

```svelte
<script lang="ts">
  import { Repo } from "automerge-repo"
  import Counter from './lib/Counter.svelte'
  import { setContextRepo } from "automerge-repo-svelte-store"

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
<script lang="ts>
  import type { DocumentId } from "automerge-repo"
  import { document } from "automerge-repo-svelte-store"

  export let docId: DocumentId

  // `document` calls `getContextRepo` internally to access the closest `Repo`.
  const doc = document<{count?: number}>(docId)
  const increment = () => {
    doc.change((d) => d.count = (d.count || 0) + 1)
  }
</script>

<button on:click={increment}>
  count is {$doc?.count || 0}
</button>
```
