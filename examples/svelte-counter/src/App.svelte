<script lang="ts">
  import svelteLogo from "./assets/svelte.svg"
  import automergeLogo from "/automerge-logo.svg"
  import Counter from "./lib/Counter.svelte"
  import type { DocType } from "./lib/doc-type"

  import {
    Counter as AutomergeCounter,
    isValidAutomergeUrl,
    type AutomergeUrl
  } from "@automerge/automerge-repo"
  
  import { repo } from "./lib/repo"
  import { setContextRepo } from "@automerge/automerge-repo-svelte-store"
  
  // Set the repo in context for components to access
  setContextRepo(repo)
  
  // Handle document initialization
  let docUrl = $state<AutomergeUrl | "">("")
  
  async function initializeDoc() {
    const rootDocUrl = `${document.location.hash.substring(1)}`
    
    if (isValidAutomergeUrl(rootDocUrl)) {
      const handle = await repo.find(rootDocUrl)
      document.location.hash = handle.url
      return handle.url
    } else {
      const handle = await repo.create<DocType>({ count: new AutomergeCounter() })
      document.location.hash = handle.url
      return handle.url
    }
  }
  
  $effect(() => {
    initializeDoc().then(url => {
      docUrl = url as AutomergeUrl
    })
  })
</script>

<main>
  <div>
    <a href="https://automerge.org" target="_blank" rel="noreferrer">
      <img src={automergeLogo} class="logo" alt="Automerge Logo" />
    </a>
    <a href="https://svelte.dev" target="_blank" rel="noreferrer">
      <img src={svelteLogo} class="logo svelte" alt="Svelte Logo" />
    </a>
  </div>
  <h1>Automerge + Svelte</h1>

  <div class="card">
    {#if docUrl}
      <Counter documentUrl={docUrl} />
    {/if}
  </div>

  <p class="read-the-docs">
    Click on the Automerge and Svelte logos to learn more
  </p>
</main>

<style>
  .logo {
    height: 6em;
    padding: 1.5em;
    will-change: filter;
    transition: filter 300ms;
  }
  .logo:hover {
    filter: drop-shadow(0 0 2em #ff8d00aa);
  }
  .logo.svelte:hover {
    filter: drop-shadow(0 0 2em #ff3e00aa);
  }
  .read-the-docs {
    color: #888;
  }
</style>
