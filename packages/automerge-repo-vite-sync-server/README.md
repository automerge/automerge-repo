Unfinished Automerge websocket server for Vite (Svelte, SvelteKit, etc)

How to get started:

In vite.config.ts, add the following:

```
import { websocket } from "@automerge/automerge-repo-svelte-sync-server/webSocketUtils"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [..., wasm(), websocket()],

  worker: {
    plugins: [wasm()]
  },
  
  optimizeDeps: {
    // This is necessary because otherwise `vite dev` includes two separate
    // versions of the JS wrapper. This causes problems because the JS wrapper
    // has a module level variable to track JS side heap allocations, and
    // initializing this twice causes horrible breakage.
    exclude: [
      "@automerge/automerge-wasm",
      "@automerge/automerge-wasm/bundler/bindgen_bg.wasm",
      "@syntect/wasm"
    ]
  }
})

```

## References

The majority of the Websocket server code was pulled from https://github.com/suhaildawood/SvelteKit-integrated-WebSocket/. Thanks, @suhaildawood!