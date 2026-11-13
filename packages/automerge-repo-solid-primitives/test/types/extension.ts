// A handle extension and a backend providing it, for the type checks.
import { MemoryBackend, Repo } from "@automerge/automerge-repo"
import {
  provides,
  type HandleExtension,
} from "@automerge/automerge-repo/sedimentree"

/** What `ping` adds to the handles of a Repo on a backend listing it. */
interface PingSpec {
  members: { ping(): string }
  events: { pong: {} }
}

declare const ping: HandleExtension
export class PingBackend extends MemoryBackend {
  readonly handleExtensions = provides<PingSpec>(ping)
}
export const repo = new Repo({ backend: new PingBackend() })
export type Todo = { title: string }
