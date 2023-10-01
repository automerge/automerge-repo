<script lang="ts">
  import { document } from "@automerge/automerge-repo-svelte-store"
  import { type AutomergeUrl } from "@automerge/automerge-repo"

  export let documentUrl: AutomergeUrl

  interface HasCount {
    count?: number
  }

  const doc = document<HasCount>(documentUrl)
  const increment = () => {
    doc.change((d: HasCount) => (d.count = (d.count || 0) + 1))
  }
</script>

<button on:click={increment}>
  count is {$doc?.count || 0}
</button>
