import type { DocHandleChangePayload } from "@automerge/automerge-repo/slim"
import { applyPatches } from "@automerge/automerge/slim"

/**
 * convert automerge patches to solid producer operations
 * @param payload the
 * [DocHandleChangePayload](https://automerge.org/automerge-repo/interfaces/_automerge_automerge_repo.DocHandleChangePayload.html)
 * from the handle.on("change
 * @returns a callback for an immer-like function. e.g.
 * [produce](https://docs.solidjs.com/reference/store-utilities/produce) for
 * [Solid
 * Stores](https://docs.solidjs.com/reference/store-utilities/create-store)
 */
export default function autoproduce<T>(
  payload: DocHandleChangePayload<T>
): (doc: T) => void {
  return (doc: T) => applyPatches(doc, payload.patches)
}
