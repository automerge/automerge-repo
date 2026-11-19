// Compile-time checks of the package as an app consumes it: through its
// built declarations, under the strictest optional-property setting.
import { Repo } from "@automerge/automerge-repo/slim"
import {
  defineExtension,
  provides,
  type EventFor,
  type SedimentreeSession,
} from "@automerge/automerge-repo/sedimentree"
import {
  SubductionBackend,
  ephemeral,
  type EphemeralInbound,
  type SubductionEvent,
  type SubductionExtensions,
  type SubductionSession,
} from "@automerge/automerge-repo-subduction"

declare const backend: SubductionBackend
async function use() {
  const repo: Repo<SubductionExtensions> = new Repo({ backend })
  ;(await repo.create({})).broadcast("x")
}
declare const session: SubductionSession
void session.publishEphemeral

// The extension's kind builds a typed event.
declare const payload: EphemeralInbound
const sent: SubductionEvent = {
  type: "extension",
  sequence: 0,
  kind: ephemeral.kind,
  payload,
}

// A subclass may add extensions.
class More extends SubductionBackend {
  override readonly handleExtensions = provides(
    ephemeral,
    defineExtension<SedimentreeSession, { members: { label(): string } }>({
      kind: "label",
      members: { label: () => this.peerId },
    })
  )
}
async function more(b: More) {
  const handle = await new Repo({ backend: b }).create({})
  handle.broadcast("x")
  handle.label().toUpperCase()
}
const moreEvent: EventFor<More> = sent

void [use, more, moreEvent]
