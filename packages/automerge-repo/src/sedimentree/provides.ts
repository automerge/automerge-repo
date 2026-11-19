import type {
  HandleExtensions,
  SedimentreeBackend,
  SedimentreeEvent,
  SedimentreeSession,
} from "./backend.js"
import type {
  AnyHandleExtension,
  ExtensionEvent,
  HandleExtensionSpec,
  HandleFeatures,
  InboundOf,
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

// For one listed extension `E`: its spec, what it adds to handles, the
// session it needs, and the event its backend sends it.

type SpecOf<E> = E extends {
  readonly "~spec"?: infer X extends HandleExtensionSpec
}
  ? Known<X, {}>
  : {}

type FeaturesOf<E> = E extends unknown ? HandleFeatures<SpecOf<E>> : never

type SessionOf<E> = E extends {
  readonly "~session"?: (session: infer S) => void
}
  ? Known<S, SedimentreeSession>
  : SedimentreeSession

/** None if the spec declares no kind, or one too wide to tell it from others. */
type EventOf<E> = E extends unknown
  ? SpecOf<E> extends { kind: infer K extends string }
    ? string extends K
      ? never
      : ExtensionEvent<K, InboundOf<SpecOf<E>>>
    : never
  : never

/**
 * The extensions {@link provides} lists, `E` being any one of them: what
 * they add to handles, what they need of a session, and the events their
 * backend sends them.
 *
 * @experimental
 */
export type ProvidedExtensions<E extends AnyHandleExtension> =
  readonly AnyHandleExtension[] & {
    /** Type only: never set. */
    readonly "~spec"?: All<FeaturesOf<E> | {}>
    /** Type only: never set. */
    readonly "~session"?: All<SessionOf<E> | SedimentreeSession>
    /** Type only: never set. */
    readonly "~events"?: (event: EventOf<E>) => void
  }

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
): ProvidedExtensions<L[number]> {
  return extensions
}

/** What the handle extensions of a backend type `B` add; `{}` if untyped. */
export type ExtensionsOf<B extends SedimentreeBackend<any>> = B extends {
  readonly handleExtensions?: HandleExtensions<infer X>
}
  ? X extends HandleExtensionSpec
    ? X
    : {}
  : {}

/**
 * The events a backend type `B` sends on its sessions: the core ones, and
 * one `extension` event for each of its extensions whose spec declares a
 * kind. Type a backend's event queue with it:
 *
 * ```ts
 * type MyEvent = EventFor<MyBackend>
 * ```
 *
 * @experimental
 */
export type EventFor<B> =
  | SedimentreeEvent
  | (B extends {
      readonly handleExtensions?: {
        readonly "~events"?: (event: infer Ev) => void
      }
    }
      ? Known<Ev, never>
      : never)

/**
 * The session a backend type `B` must give from `open()`: everything its
 * extensions need of a session, with its events typed by {@link EventFor}:
 *
 * ```ts
 * class MyBackend implements SedimentreeBackend<…> {
 *   readonly handleExtensions = provides(mine)
 *   open(id: SedimentreeId): SessionFor<MyBackend> { … }
 * }
 * ```
 *
 * @experimental
 */
export type SessionFor<B> = Omit<
  B extends { readonly handleExtensions?: { readonly "~session"?: infer S } }
    ? Known<S, SedimentreeSession>
    : SedimentreeSession,
  "events"
> & { readonly events: AsyncIterable<EventFor<B>> }
