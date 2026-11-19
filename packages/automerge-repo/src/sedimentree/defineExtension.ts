import type { DocHandle } from "../types/DocHandle.js"
import type { SedimentreeSession } from "./backend.js"
import type {
  EventsOf,
  ExtensionContext,
  ExtensionMembers,
  HandleExtension,
  HandleExtensionSpec,
  HandleFeatures,
} from "./extension.js"

/** The spec's members as an extension writes them: the document's
 * {@link ExtensionContext} and the calling handle first, then the caller's
 * arguments. A generic or overloaded method is `never`: it can't be reduced
 * to one argument list and return type. */
type ContextualMembers<
  S extends SedimentreeSession,
  X extends HandleExtensionSpec,
  M = ExtensionMembers<X>,
> = {
  readonly [N in keyof M]: M[N] extends (...args: infer A) => infer R
    ? ((...args: A) => R) extends M[N]
      ? (
          context: ExtensionContext<S, EventsOf<X>>,
          handle: DocHandle<unknown, HandleFeatures<X>>,
          ...args: A
        ) => R
      : never
    : never
}

/** What {@link defineExtension} takes: a {@link HandleExtension} whose
 * members are checked against the spec `X`. */
type ExtensionDefinition<
  S extends SedimentreeSession,
  X extends HandleExtensionSpec,
> = Pick<HandleExtension<S, X>, "kind" | "receive"> & {
  readonly members: ContextualMembers<S, X>
}

/**
 * A {@link HandleExtension}, checked against the spec `X` it implements:
 * its kind, and the spec's methods, with the document's context and the
 * calling handle as leading parameters that Repo supplies:
 *
 * ```ts
 * export const count = defineExtension<CountSession, CountSpec>({
 *   kind: "count",
 *   members: {
 *     async docCount(context) {
 *       const session = context.requireSession()
 *       return session.countDocs()
 *     },
 *   },
 * })
 * ```
 *
 * Methods must be representable by one argument tuple and return type.
 * Generic or overloaded signatures that need more are rejected; use
 * concrete, single-signature methods instead.
 *
 * @experimental
 */
export function defineExtension<
  S extends SedimentreeSession = SedimentreeSession,
  X extends HandleExtensionSpec = {},
>(definition: ExtensionDefinition<S, X>): HandleExtension<S, X> {
  return definition as HandleExtension<S, X>
}
