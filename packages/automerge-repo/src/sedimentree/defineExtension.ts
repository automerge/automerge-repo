import type { HandleExtension, HandleExtensionSpec } from "./extension.js"

/**
 * A {@link HandleExtension} of the spec `X`: the spec's methods, with the
 * document's context and the calling handle as leading parameters that Repo
 * supplies, and a receiver for each kind of event its backend sends it:
 *
 * ```ts
 * export const count = defineExtension<CountSpec>({
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
export function defineExtension<X extends HandleExtensionSpec = {}>(
  extension: HandleExtension<X>
): HandleExtension<X> {
  return extension
}
