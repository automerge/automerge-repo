import "@automerge/subduction" // initializes Subduction's Wasm
import {
  Repo,
  RepoContext,
  isValidAutomergeUrl,
  type AutomergeUrl,
  type DocHandle,
} from "@automerge/react"
import {
  KeyhiveBackend,
  initKeyhiveWasm,
  setKeyhiveLogLevel,
  type KeyhiveExtensions,
} from "@automerge/automerge-repo-subduction-keyhive"
import { WebSocketNetworkAdapter } from "@automerge/automerge-repo-subduction-network-websocket"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-subduction-storage-indexeddb"
import { createMemorySigner } from "@automerge/subduction/slim"

import React, { Suspense } from "react"
import { ErrorBoundary } from "react-error-boundary"
import ReactDOM from "react-dom/client"
import { App } from "./App.js"
import { ConsoleKeyhive, fromHex } from "./keyhive.js"
import { State } from "./types.js"
import "./index.css"

/** The `--key-seed` the README starts the local server with. */
const DEFAULT_SERVER_SEED = new Uint8Array(32).fill(7)

const params = new URLSearchParams(location.search)

// Each tab name is its own replica: its own IndexedDB, signing key and keyhive.
// Without `?as=`, reuse this browser's last name so a restart keeps its identity.
const LAST_NAME = "automerge-repo-demo-todo-keyhive:last-as"
let me = params.get("as")
if (!me) {
  try {
    me = localStorage.getItem(LAST_NAME)
  } catch {}
  me ??= `tab-${Math.random().toString(36).slice(2, 6)}`
  params.set("as", me)
  history.replaceState(null, "", `?${params}${location.hash}`)
}
try {
  localStorage.setItem(LAST_NAME, me)
} catch {}
document.title = `${me} · keyhive todo`

const server = new URL(params.get("server") ?? "ws://127.0.0.1:8080")
const relay = params.get("relay")
  ? fromHex(params.get("relay")!)
  : createMemorySigner(DEFAULT_SERVER_SEED).verifyingKey()

initKeyhiveWasm()
setKeyhiveLogLevel((params.get("log") as never) ?? "warn")

const storage = new IndexedDBStorageAdapter({
  database: `automerge-repo-demo-todo-keyhive-${me}`,
})
const backend = await KeyhiveBackend.load({
  storage,
  network: [new WebSocketNetworkAdapter(server)],
  relays: [relay],
})
const repo = new Repo({ backend })
const kh = new ConsoleKeyhive(me, backend, repo)

declare global {
  interface Window {
    backend: KeyhiveBackend
    handle: DocHandle<State, KeyhiveExtensions>
    kh: ConsoleKeyhive
    repo: Repo
  }
}

window.backend = backend
window.kh = kh
window.repo = repo
kh.help()

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement)
const status = (text: string) =>
  root.render(<div className="p-4 font-mono text-sm">{text}</div>)

/** Find `url`, retrying while this replica has no access to it yet. */
async function findWithAccess(url: AutomergeUrl) {
  void kh
    .card()
    .then(card =>
      console.info(
        `[${me}] to share with this tab from anywhere, run there:\n` +
          `await kh.share("${card}")`
      )
    )
  for (;;) {
    try {
      return await repo.find<State>(url, { signal: AbortSignal.timeout(10000) })
    } catch (error) {
      console.info(`[${me}] no access to the list yet, retrying`, error)
      status(
        `${me}: waiting for access… share from another tab with kh.share("${me}")`
      )
      kh.sync()
      await new Promise(resolve => setTimeout(resolve, 3000))
    }
  }
}

const rootDocUrl = document.location.hash.substring(1)
let handle: DocHandle<State, KeyhiveExtensions>
if (isValidAutomergeUrl(rootDocUrl)) {
  handle = await findWithAccess(rootDocUrl)
} else {
  handle = await repo.create<State>({ todos: [] })
  kh.handle = handle
  await kh.initList(handle)
}
const docUrl = (document.location.hash = handle.url)
kh.handle = handle
window.handle = handle

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void (async () => {
      try {
        await repo.shutdown()
      } finally {
        try {
          await backend.close()
        } finally {
          await storage.close()
        }
      }
    })().catch(console.error)
  })
}

root.render(
  <RepoContext.Provider value={repo}>
    <React.StrictMode>
      <div className="fixed top-2 left-2 text-xs font-mono text-neutral-500">
        {me} · open the console and run <code>kh.help()</code>
      </div>
      <ErrorBoundary fallback={<div>Something went wrong</div>}>
        <Suspense fallback={<div>Loading...</div>}>
          <App url={docUrl} />
        </Suspense>
      </ErrorBoundary>
    </React.StrictMode>
  </RepoContext.Provider>
)
