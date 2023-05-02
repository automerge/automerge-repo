<script lang="ts">
  import svelteLogo from "./assets/svelte.svg"
  import automergeLogo from "/automerge-logo.svg"
  import Counter from "./lib/Counter.svelte"

  import { Repo } from "automerge-repo"
  import { BroadcastChannelNetworkAdapter } from "automerge-repo-network-broadcastchannel"
  import { LocalForageStorageAdapter } from "automerge-repo-storage-localforage"
  import { BrowserWebSocketClientAdapter } from "automerge-repo-network-websocket"
  import { setContextRepo } from "automerge-repo-svelte-store"

  const repo = new Repo({
    network: [
      new BroadcastChannelNetworkAdapter(),
      new BrowserWebSocketClientAdapter("ws://localhost:3030"),
    ],
    storage: new LocalForageStorageAdapter(),
  })

  setContextRepo(repo)

  let rootDocId = localStorage.rootDocId
  if (!rootDocId) {
    const handle = repo.create()
    localStorage.rootDocId = rootDocId = handle.documentId
  }
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
    <Counter documentId={rootDocId} />
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
