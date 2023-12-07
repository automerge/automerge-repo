import { building } from "$app/environment"
import type { Handle, RequestEvent } from "@sveltejs/kit"
import {
  ExtendedGlobal,
  ExtendedWebSocketServer,
  GlobalThisWSS,
  onHttpServerUpgrade,
  createWSSGlobalInstance,
} from "./webSocketUtils.js"
import { Repo } from "@automerge/automerge-repo"
import { NodeWSServerAdapter } from "@automerge/automerge-repo-network-websocket"
import { NodeFSStorageAdapter } from "@automerge/automerge-repo-storage-nodefs"
import os from "os"

export { onHttpServerUpgrade, createWSSGlobalInstance }

let wssInitialized = false
const startupWebsocketServer = () => {
  if (wssInitialized) return
  console.log("[wss:kit] setup")
  const wss = (globalThis as ExtendedGlobal)[GlobalThisWSS]
  if (wss !== undefined) {
    console.log("[wss:kit] initializing")

    const config = {
      network: [new NodeWSServerAdapter(wss)],
      storage: new NodeFSStorageAdapter("./.automerge"),
      peerId: `storage-server-${os.hostname()}`,
      sharePolicy: async () => false,
    }

    // @ts-ignore
    const repo = new Repo(config)

    // wss.on("connection", (ws, _request) => {
    //   // This is where you can authenticate the client from the request
    //   // const session = await getSessionFromCookie(request.headers.cookie || '');
    //   // if (!session) ws.close(1008, 'User not authenticated');
    //   // ws.userId = session.userId;
    //   console.log(`[wss:kit] client connected (${ws.socketId})`)
    //   ws.send(
    //     `Hello from SvelteKit ${new Date().toLocaleString()} (${ws.socketId})]`
    //   )

    //   ws.on("close", () => {
    //     console.log(`[wss:kit] client disconnected (${ws.socketId})`)
    //   })
    // })
    wssInitialized = true
  }
}

export function SvelteKitAutomergeRepoSyncServer(): Handle {
  return async ({ event, resolve }) => {
    startupWebsocketServer()
    // Skip WebSocket server when pre-rendering pages
    if (!building) {
      const wss = (globalThis as ExtendedGlobal)[GlobalThisWSS]
      if (wss !== undefined) {
        event.locals.wss = wss
      }
    }
    const response = await resolve(event, {
      filterSerializedResponseHeaders: name => name === "content-type",
    })
    return response
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace App {
    interface Locals {
      wss: ExtendedWebSocketServer | null
    }
  }
}
