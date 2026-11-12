import type { DocumentId } from "../types.js"
import type { HandleExtension } from "./extension.js"

/**
 * For the tests of a package that provides handle extensions: throws unless
 * `extensions`, in this order, can extend a handle together. On top of what
 * Repo checks when it is built (distinct kinds, each a subclass adding
 * members that no one else has), it rejects an extension that sets a
 * property on the handle itself, such as a class field. Those are invisible
 * to Repo's check, so one could silently replace another extension's, or a
 * handle's own. Extensions add methods and getters only; state they need
 * goes in private (`#`) fields, which cannot clash.
 *
 * @experimental
 */
export async function checkHandleExtensions(
  extensions: readonly HandleExtension[]
): Promise<void> {
  // Loaded on use, so that this entry point stays free of Repo's runtime.
  const { extendHandle } = await import("../DocHandle.js")
  const { DocumentState } = await import("../DocumentState.js")
  extendHandle(extensions)
  for (const [index, extension] of extensions.entries()) {
    // The handle as the extensions before this one leave it, then frozen:
    // anything this extension sets on it throws.
    class Frozen extends extendHandle(extensions.slice(0, index))<unknown> {
      constructor(
        ...args: ConstructorParameters<ReturnType<typeof extendHandle>>
      ) {
        super(...args)
        Object.freeze(this)
      }
    }
    const Handle = extension.extend(Frozen, () => {
      throw new Error("There is no document during this check")
    }) as ReturnType<typeof extendHandle>
    try {
      // Builds the root handle, with no backend behind it.
      new DocumentState("check" as DocumentId, {
        commit: async () => {},
        Handle,
      })
    } catch (cause) {
      throw new Error(
        `Handle extension ${extension.kind} sets a property on the handle; extensions may only add methods and getters`,
        { cause }
      )
    }
  }
}
