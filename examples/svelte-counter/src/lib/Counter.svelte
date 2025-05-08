<script lang="ts">
  import { type AutomergeUrl } from "@automerge/automerge-repo"
  import { document, type AutomergeDocumentStore } from "@automerge/automerge-repo-svelte-store"
  import type { DocType } from "./doc-type"
  
  // Use props rune for component props
  const { documentUrl } = $props<{
    documentUrl: AutomergeUrl
  }>();
  
  // Document state
  let docStore = $state<AutomergeDocumentStore<DocType> | null>(null);
  let loading = $state(true);
  let error = $state<Error | null>(null);
  
  // Load the document on mount
  $effect(() => {
    if (documentUrl) {
      loading = true;
      error = null;
      
      document<DocType>(documentUrl)
        .then((store: AutomergeDocumentStore<DocType> | null) => {
          docStore = store;
          loading = false;
        })
        .catch((err: unknown) => {
          console.error("Failed to load document:", err);
          error = err instanceof Error ? err : new Error(String(err));
          loading = false;
        });
    }
  });
  
  // Function to increment count
  function increment() {
    if (docStore) {
      docStore.change((d: DocType) => {
        d.count.increment(1);
      });
    }
  }
  
  // Create a reactive binding to the document
  $effect.root(() => {
    if (docStore) {
      return docStore.subscribe(() => {});
    }
  });
</script>

{#if loading}
  <div>Loading...</div>
{:else if error}
  <div>Error: {error.message}</div>
{:else if $docStore}
  <button onclick={increment}>
    count is {$docStore.count.value}
  </button>
{:else}
  <div>No document available</div>
{/if}