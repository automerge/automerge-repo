import { defineExtension } from "@automerge/automerge-repo/sedimentree"
import { DocKeyhive, documentClosed } from "./DocKeyhive.js"
import type { KeyhiveSession } from "./KeyhiveSession.js"

/** What the `keyhive` extension adds to a handle. */
export interface KeyhiveMembers {
  /**
   * The keyhive operations on the handle's document. Throws once the document
   * is closed.
   */
  keyhive(): DocKeyhive
}

/** The `keyhive` extension's spec. */
export interface KeyhiveSpec {
  session: KeyhiveSession
  members: KeyhiveMembers
}

/** Keyhive membership on every handle (`handle.keyhive()`). */
export const keyhive = defineExtension<KeyhiveSpec>({
  members: {
    keyhive(context) {
      const { session } = context
      if (!session) throw documentClosed()
      return new DocKeyhive(
        session.local,
        session.id,
        session.storedHeads,
        () => context.session
      )
    },
  },
})
