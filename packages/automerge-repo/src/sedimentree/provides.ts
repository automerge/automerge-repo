import type { HandleExtensions, SedimentreeEvent } from "./backend.js"
import type {
  AnyHandleExtension,
  ExtensionEvent,
  HandleExtensionSpec,
  ReceivesOf,
  SessionOf,
} from "./extension.js"

/** `T`, or `Fallback` where `T` is `any` or missing: an untyped extension. */
type Known<T, Fallback> = 0 extends 1 & T
  ? Fallback
  : unknown extends T
    ? Fallback
    : T

/** `A | B` as `A & B`: what every member of a union has. */
type All<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I
) => void
  ? I
  : never

/** The spec a listed extension `E` carries; `{}` if it carries none. */
type SpecOf<E> = E extends { readonly "~spec"?: infer X } ? Known<X, {}> : {}

/**
 * Lists `extensions` for a backend: every handle of a Repo on it gets what
 * they add, together:
 *
 * ```ts
 * readonly handleExtensions = provides(mine, theirs)
 * ```
 *
 * A plain array declares nothing.
 *
 * @experimental
 */
export function provides<const L extends readonly AnyHandleExtension[]>(
  ...extensions: L
): HandleExtensions<All<SpecOf<L[number]> | {}>> {
  return extensions
}

/**
 * The spec of a backend type `B`: the intersection of those of the
 * extensions it lists; `{}` if untyped. A Repo on it is a
 * `Repo<ExtensionsOf<B>>`.
 */
export type ExtensionsOf<B> = B extends {
  readonly handleExtensions?: HandleExtensions<infer X>
}
  ? X extends HandleExtensionSpec
    ? X
    : {}
  : {}

/** One `extension` event for each kind the spec `X` receives. */
type Received<X extends HandleExtensionSpec, R = ReceivesOf<X>> = {
  [K in keyof R & string]: ExtensionEvent<K, R[K]>
}[keyof R & string]

/**
 * The events a backend type `B` sends on its sessions: the core ones, and
 * one `extension` event for each kind its extensions receive. Type a
 * backend's event queue with it:
 *
 * ```ts
 * type MyEvent = EventFor<MyBackend>
 * ```
 *
 * @experimental
 */
export type EventFor<B> = SedimentreeEvent | Received<ExtensionsOf<B>>

/**
 * The session a backend type `B` must give from `open()`: everything its
 * extensions need of a session, with its events typed by {@link EventFor}:
 *
 * ```ts
 * class MyBackend implements SedimentreeBackend {
 *   readonly handleExtensions = provides(mine)
 *   open(id: SedimentreeId): SessionFor<MyBackend> { … }
 * }
 * ```
 *
 * @experimental
 */
export type SessionFor<B> = Omit<SessionOf<ExtensionsOf<B>>, "events"> & {
  readonly events: AsyncIterable<EventFor<B>>
}
