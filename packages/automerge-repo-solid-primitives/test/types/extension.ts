// A handle extension and a backend providing it, for the type checks.
import { MemoryBackend, Repo } from "@automerge/automerge-repo"
import type {
  ExtensionTypes,
  HandleExtension,
} from "@automerge/automerge-repo/sedimentree"

// Its member depends on the handle's document type.
interface PingMembers<T> {
  ping(): T
}
interface PingTypes extends ExtensionTypes {
  kind: "ping"
  members: PingMembers<this["T"]>
  events: { pong: {} }
  inbound: never
}

declare const ping: HandleExtension<PingTypes>
export class PingBackend extends MemoryBackend {
  readonly handleExtensions = [ping] as const
}
export const repo = new Repo({ backend: new PingBackend() })
export type Todo = { title: string }
