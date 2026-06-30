import type { Repo } from "../../src/Repo.js"
import { awaitEvent } from "./awaitEvent.js"

/**
 * Resolve once the repo's subduction link is up, driven by the
 * "subduction-connection" event rather than polling. Returns immediately if it
 * is already connected.
 *
 * Only the connected case is offered: there is no prompt disconnect signal
 * (clients reconnect lazily, so isSubductionConnected() does not flip promptly
 * on a server outage), so awaiting a disconnect would be unreliable.
 */
export async function awaitSubductionConnected(
  repo: Repo,
  { timeout }: { timeout?: number } = {}
): Promise<void> {
  if (repo.isSubductionConnected()) return
  await awaitEvent<{ connected: boolean }>(
    repo,
    "subduction-connection",
    e => e.connected,
    { timeout }
  )
}
