// A handle extension and a backend providing it, for the type checks.
import { MemoryBackend, Repo, type DocHandle } from "@automerge/automerge-repo"
import type { HandleExtension } from "@automerge/automerge-repo/sedimentree"

declare module "@automerge/automerge-repo/sedimentree" {
  interface HandleExtensionTypes<T> {
    ping: {
      members: { ping(): T }
      events: { pong: (payload: { handle: DocHandle<T, "ping"> }) => void }
      inbound: never
    }
  }
}

declare const ping: HandleExtension<"ping">
export class PingBackend extends MemoryBackend {
  readonly handleExtensions = [ping] as const
}
export const repo = new Repo({ backend: new PingBackend() })
export type Todo = { title: string }
