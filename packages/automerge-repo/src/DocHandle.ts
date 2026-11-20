import { Handle, handleState } from "./Handle.js"
import type {
  AnyHandleExtension,
  HandleExtensionSpec,
} from "./sedimentree/extension.js"

export type { HandleEvents } from "./automerge/handle.js"

/**
 * @internal The members a handle defines on each instance, not its
 * prototype. Extensions may not redefine these either.
 */
export const instanceMembers: readonly string[] = ["isReady", "isDeleted"]

/**
 * @internal One subclass of a doc type's handle class per Repo, with the
 * backend's extension methods on its prototype. Instances keep the base
 * classes' private fields and constructors. With no extensions, the type's
 * class itself.
 */
export function extendHandle<C extends typeof Handle<any, any, any>>(
  extensions: readonly AnyHandleExtension[],
  Base: C
): C {
  if (!extensions.length) return Base
  class Extended<
    S,
    X extends HandleExtensionSpec = {},
    E extends object = any,
  > extends (Base as typeof Handle)<S, X, E> {}
  const kinds = new Set<string>()
  for (const { members, receive = {} } of extensions) {
    // The keys Repo routes events by: own string keys.
    for (const kind of Object.getOwnPropertyNames(receive)) {
      if (kinds.has(kind))
        throw new Error(`Two handle extensions receive ${kind}`)
      kinds.add(kind)
    }
    for (const name of Reflect.ownKeys(members)) {
      // Extensions only add: a replaced member would change the handle for
      // everyone else, and cannot be typed. The doc type's members count.
      if (
        name in Extended.prototype ||
        (typeof name === "string" && instanceMembers.includes(name))
      )
        throw new Error(`A handle extension redefines ${String(name)}`)
      const member = members[name]
      Object.defineProperty(Extended.prototype, name, {
        value: function (this: Handle<any, any, any>, ...args: unknown[]) {
          return member(handleState(this).extensionContext, this, ...args)
        },
        writable: true,
        configurable: true,
      })
    }
  }
  return Extended as unknown as C
}
