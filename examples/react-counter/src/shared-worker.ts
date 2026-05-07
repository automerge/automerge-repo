/// <reference lib="webworker" />
declare const self: SharedWorkerGlobalScope
export {}

self.addEventListener("connect", (e: MessageEvent) => {
  configureRepoNetworkPort(e.ports[0])
})

// Because automerge is a WASM module and loads asynchronously,
// a bug in Chrome causes the 'connect' event to fire before the
// module is loaded. This promise lets us block until the module loads
// even if the event arrives first.
// Ideally Chrome would fix this upstream but this isn't a terrible hack.
const repoPromise = (async () => {
  const { Repo, IndexedDBStorageAdapter, MessageChannelNetworkAdapter } =
    await import("@automerge/react")

  // @ts-ignore — initSync is not in the type declarations but is exported at runtime
  const { initSync } = await import("@automerge/automerge-subduction/slim")
  // @ts-ignore — wasm-base64 has no type declarations
  const { wasmBase64 } = await import(
    "@automerge/automerge-subduction/wasm-base64"
  )
  initSync(Uint8Array.from(atob(wasmBase64), (c: string) => c.charCodeAt(0)))

  return {
    repo: new Repo({
      storage: new IndexedDBStorageAdapter(),
      subductionWebsocketEndpoints: ["wss://subduction.sync.inkandswitch.com"],
      peerId: ("shared-worker-" + Math.round(Math.random() * 10000)) as any,
      sharePolicy: async peerId => peerId.includes("storage-server"),
    }),
    MessageChannelNetworkAdapter,
  }
})()

async function configureRepoNetworkPort(port: MessagePort) {
  const { repo, MessageChannelNetworkAdapter } = await repoPromise

  // be careful to not accidentally create a strong reference to port
  // that will prevent dead ports from being garbage collected
  repo.networkSubsystem.addNetworkAdapter(
    new MessageChannelNetworkAdapter(port, { useWeakRef: true })
  )
}
