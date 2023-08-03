<script lang="ts">
  import { document } from "@automerge/automerge-repo-svelte-store"
  import { type DocumentId } from "@automerge/automerge-repo"

  export let documentId: DocumentId

  interface HasCount {
    count?: number
  }

  const doc = document<HasCount>(documentId)
  const increment = () => {
    doc.change((d: HasCount) => d.count = (d.count || 0) + 1)
  }
</script>

<button on:click={increment}>
  count is {$doc?.count || 0}
</button>
