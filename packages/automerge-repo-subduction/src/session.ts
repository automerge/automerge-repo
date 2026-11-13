import type * as N from "@automerge/subduction/slim"
import type { SedimentreeId } from "@automerge/automerge-repo/sedimentree"
import type { Watch } from "./watch.js"
import type { SubductionEvent } from "./ephemeral.js"

/** Backend-side state of one open session. */
export interface SessionState {
  readonly id: SedimentreeId
  readonly watch: Watch<SubductionEvent>
  /** The native stream feeding this session, once started. */
  stream?: N.StoredUpdates
  released: boolean
  /** The consumer is ready (markReady); readiness work stops. */
  ready: boolean
  /** A confirmation round is in flight. */
  confirming: boolean
}
