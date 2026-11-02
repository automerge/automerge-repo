import type * as N from "@automerge/subduction/slim"
import type {
  SedimentreeEvent,
  SedimentreeId,
} from "@automerge/automerge-repo/sedimentree"
import type { Watch } from "./watch.js"

/** Backend-side state of one open session. */
export interface SessionState {
  readonly id: SedimentreeId
  readonly watch: Watch<SedimentreeEvent>
  /** The native stream feeding this session, once started. */
  stream?: N.StoredUpdates
  released: boolean
  /** The consumer verified a complete snapshot (markComplete). */
  completed: boolean
  /** A confirmation round is in flight. */
  confirming: boolean
}
