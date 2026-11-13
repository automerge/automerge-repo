import type { SedimentreeSession } from "./backend.js"
import type {
  EventsOf,
  ExtensionContext,
  ExtensionMembers,
  HandleClass,
  HandleExtension,
  HandleExtensionSpec,
} from "./extension.js"

/** The spec's members as an extension defines them: each method takes the
 * document's {@link ExtensionContext} first; callers never see it. */
export type ContextualMembers<
  S extends SedimentreeSession,
  X extends HandleExtensionSpec,
> = {
  readonly [N in keyof ExtensionMembers<X>]: ExtensionMembers<X>[N] extends (
    ...args: infer A
  ) => infer R
    ? (context: ExtensionContext<S, EventsOf<X>>, ...args: A) => R
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
 * A {@link HandleExtension} from plain functions: the ergonomic way to write
 * one. Members are the spec's, checked against it, with the document's
 * context as a leading parameter the builder supplies:
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
 * Members defined this way are methods only, with no per-handle state; an
 * extension that needs getters or instance fields implements
 * {@link HandleExtension} itself.
 *
 * @experimental
 */
export function defineExtension<
  S extends SedimentreeSession = SedimentreeSession,
  X extends HandleExtensionSpec = {},
  P = unknown,
>(
  definition: ExtensionDefinition<S, X, P>
): HandleExtension<S, EventsOf<X>, P> {
  const { kind, members, receive } = definition
  const extension: HandleExtension<S, EventsOf<X>, P> = {
    kind,
    extend(base: HandleClass, context) {
      class Extended extends base {}
      for (const [name, member] of Object.entries(members)) {
        Object.defineProperty(Extended.prototype, name, {
          value: function (
            this: InstanceType<HandleClass>,
            ...args: unknown[]
          ) {
            return (member as (...inner: unknown[]) => unknown)(
              context(this),
              ...args
            )
          },
          writable: true,
          configurable: true,
        })
      }
      return Extended
    },
  }
  if (receive) extension.receive = receive
  return extension
}
