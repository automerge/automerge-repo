import type { DocHandle } from "../types/DocHandle.js"
import type { SedimentreeSession } from "./backend.js"
import type {
  EventsOf,
  ExtensionContext,
  ExtensionMembers,
  HandleExtension,
  HandleExtensionSpec,
} from "./extension.js"

/** The spec's members as an extension defines them: each method takes the
 * document's {@link ExtensionContext} and the handle it was called on first;
 * callers pass neither. Reject signatures whose generic or overload
 * relationships would be lost by reducing them to one argument tuple and
 * return type. */
export type ContextualMembers<
  S extends SedimentreeSession,
  X extends HandleExtensionSpec,
> = {
  readonly [N in keyof ExtensionMembers<X>]: ExtensionMembers<X>[N] extends (
    ...args: infer A
  ) => infer R
    ? ((...args: A) => R) extends ExtensionMembers<X>[N]
      ? (
          context: ExtensionContext<S, EventsOf<X>>,
          handle: DocHandle<unknown, X>,
          ...args: A
        ) => R
      : never
    : never
}

/** What {@link defineExtension} takes; see {@link HandleExtension} for `S`
 * (the session the extension needs) and `P` (its inbound payload). */
export interface ExtensionDefinition<
  S extends SedimentreeSession,
  X extends HandleExtensionSpec,
  P = unknown,
> {
  readonly kind: string
  /** The members of the spec `X`, each taking the context first. */
  readonly members: ContextualMembers<S, X>
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. */
  readonly receive?: (
    context: ExtensionContext<S, EventsOf<X>>,
    payload: P
  ) => void
}

/**
 * A {@link HandleExtension}, checked against the spec `X` it implements:
 * the spec's methods, with the document's context and the calling handle as
 * leading parameters that Repo supplies:
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
  P = unknown,
>(
  definition: ExtensionDefinition<S, X, P>
): HandleExtension<S, EventsOf<X>, P, X> {
  return definition
}
