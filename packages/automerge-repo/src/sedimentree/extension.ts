import type { CoreHandle } from "../types/DocHandle.js"
import type { AnyHandle } from "../Handle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"
import type { SedimentreeId } from "./ids.js"

/**
 * Everything about one handle extension's types: what it needs of a
 * session, what its backend sends it, the members it adds to handles and the
 * events it emits on them. Each extension carries its own spec (see
 * {@link defineExtension}); a backend's is the intersection of those of the
 * extensions it lists (see {@link provides}).
 *
 * ```ts
 * interface MySpec {
 *   session: MySession
 *   receives: { mine: { n: number } }
 *   members: { mine(): string }
 *   events: { "mine-event": { n: number } }
 * }
 * const mine = defineExtension<MySpec>({ … })
 * class MyBackend implements SedimentreeBackend {
 *   readonly handleExtensions = provides(mine)
 *   // …
 * }
 * ```
 *
 * A member that depends on the handle's document type takes it from the
 * calling handle: `first<T>(this: DocHandle<T>): T`.
 *
 * @experimental
 */
export interface HandleExtensionSpec {
  /** The session the extension needs: name only what it calls. */
  readonly session?: SedimentreeSession
  /** Payloads of the `extension` events its backend sends it, by kind. */
  readonly receives?: object
  /** The methods added to a handle. */
  readonly members?: object
  /** Added events' payloads by name. Each also carries the `handle` it is
   * emitted on, which Repo adds. */
  readonly events?: object
}

/** The session the spec `X` needs; the base session if it names none. */
export type SessionOf<X extends HandleExtensionSpec> = X extends {
  session: infer S extends SedimentreeSession
}
  ? S
  : SedimentreeSession

/** What the spec `X`'s backend sends it: payloads by kind. */
export type ReceivesOf<X extends HandleExtensionSpec> = NonNullable<
  X["receives"]
>

/** The members the spec `X` adds to a handle. */
export type ExtensionMembers<X extends HandleExtensionSpec> = NonNullable<
  X["members"]
>

/** The events the spec `X` declares: payloads by name, without the `handle`
 * Repo adds on delivery. What {@link ExtensionContext.emit} takes. */
export type EventsOf<X extends HandleExtensionSpec> = NonNullable<X["events"]>

/** The spec's members as an extension writes them: the document's
 * {@link ExtensionContext} and the calling handle first, then the caller's
 * arguments. A generic method must declare a `this` handle, as in
 * `first<T>(this: DocHandle<T>): T`; its implementation is checked with the
 * document type as `unknown`. Any other generic or overloaded method is
 * `never`: it can't be reduced to one argument list and return type. A spec
 * without members takes `members: {}`. */
type ContextualMembers<
  X extends HandleExtensionSpec,
  M = ExtensionMembers<X>,
> = [keyof M] extends [never]
  ? { readonly [name: PropertyKey]: never }
  : { readonly [N in keyof M]: ContextualMember<X, M[N]> }

/** One spec method `F` as an extension writes it; `never` if it can't be. */
type ContextualMember<X extends HandleExtensionSpec, F> = F extends (
  this: infer H,
  ...args: infer A
) => infer R
  ? ((...args: A) => R) extends F
    ? Contextual<
        X,
        A,
        R,
        H extends AnyHandle ? H & ExtensionMembers<X> : CoreHandle<X>
      >
    : H extends AnyHandle
      ? Contextual<X, A, R, H & ExtensionMembers<X>>
      : never
  : never

type Contextual<
  X extends HandleExtensionSpec,
  A extends unknown[],
  R,
  H = CoreHandle<X>,
> = (context: ExtensionContext<X>, handle: H, ...args: A) => R

/** What `receive` must be when a spec's `receives` does not list its kinds
 * by name: an index signature (`Record<string, …>`) or a non-string key. No
 * value fits it, so the extension does not compile. */
export interface ReceivesMustNameItsKinds {
  readonly "~error": "list each kind in receives as a string key"
}

/** A receiver for each kind the spec receives, optional ones included: the
 * backend sent `payload` in a session event `{ type: "extension", kind }`.
 * Synchronous: Repo does not wait for it. Absent if the spec receives
 * nothing. */
type Receivers<X extends HandleExtensionSpec, R = ReceivesOf<X>> = [
  keyof R,
] extends [never]
  ? { readonly receive?: never }
  : string extends keyof R
    ? { readonly receive: ReceivesMustNameItsKinds }
    : [Exclude<keyof R, string>] extends [never]
      ? {
          readonly receive: {
            readonly [K in keyof R]-?: (
              context: ExtensionContext<X>,
              payload: Required<R>[K]
            ) => void
          }
        }
      : { readonly receive: ReceivesMustNameItsKinds }

/**
 * Adds a backend feature to every handle of a Repo using that backend; see
 * {@link SedimentreeBackend.handleExtensions}. It may only add members, not
 * replace existing ones. `X` is its {@link HandleExtensionSpec}.
 *
 * It reaches its backend through the document's session, and the backend
 * reaches it with `extension` session events of the kinds it receives.
 *
 * Write one with {@link defineExtension}.
 *
 * @experimental
 */
export type HandleExtension<X extends HandleExtensionSpec = {}> = {
  /** Type only: never set. */
  readonly "~spec"?: X
  /** The spec's methods, by string or symbol name. Each takes the document's
   * context and the handle it was called on first; callers pass neither.
   * Getters are not supported. */
  readonly members: ContextualMembers<X>
} & Receivers<X>

/** A handle extension of any spec, as Repo uses them: how lists of
 * heterogeneous extensions are typed. */
export interface AnyHandleExtension {
  readonly members: {
    readonly [name: PropertyKey]: (
      context: any,
      handle: any,
      ...args: any[]
    ) => unknown
  }
  readonly receive?: {
    readonly [kind: string]: (context: any, payload: any) => void
  }
}

/** What an extension of spec `X` can do with one document. */
export interface ExtensionContext<X extends HandleExtensionSpec = {}> {
  readonly documentId: DocumentId
  /** The document's ID as the backend knows it. */
  readonly sedimentreeId: SedimentreeId
  /** The Repo that owns the document. */
  readonly repoId: RepoId
  /** The document's open session; none before it opens or once it is closed. */
  readonly session: SessionOf<X> | undefined
  /** The document's open session, or throws if there is none. For members
   * whose contract is "the document must be open"; best-effort members
   * branch on {@link session} instead. Bound: safe to destructure. */
  requireSession(): SessionOf<X>
  /** Emit `event` on every handle of the document listening for it, with
   * the handle added to `payload`. Does nothing once the document is closed
   * or deleted. */
  emit<N extends keyof EventsOf<X> & string>(
    event: N,
    payload: EventsOf<X>[N]
  ): void
  /** Log an error; never throws. */
  log(message: string, detail: unknown): void
}

/** A session event of kind `K` from a backend to the extension receiving
 * that kind, whose receiver gets `payload`. */
export interface ExtensionEvent<K extends string = string, P = unknown> {
  readonly type: "extension"
  readonly sequence: number
  readonly kind: K
  readonly payload: P
}
