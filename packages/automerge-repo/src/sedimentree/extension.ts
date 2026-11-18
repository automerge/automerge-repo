import type { DocHandle } from "../types/DocHandle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"

/**
 * What a handle extension adds to every handle of its Repo: the members it
 * adds and the events it emits. Each extension carries its own spec (see
 * {@link defineExtension}); {@link provides} intersects the specs of the
 * extensions a backend lists.
 *
 * ```ts
 * interface MySpec {
 *   members: { mine(): string }
 *   events: { "mine-event": { n: number } }
 * }
 * const mine = defineExtension<MySession, MySpec>({ … })
 * class MyBackend implements SedimentreeBackend<MySpec> {
 *   readonly handleExtensions = provides(mine)
 *   // …
 * }
 * ```
 *
 * Members may not depend on the handle's document type.
 *
 * @experimental
 */
export interface HandleExtensionSpec {
  /** The methods added to a handle. */
  readonly members?: object
  /** Added events' payloads by name. Each also carries the `handle` it is
   * emitted on, which Repo adds. */
  readonly events?: object
}

/** The members the spec `X` adds to a handle. */
export type ExtensionMembers<X extends HandleExtensionSpec> = X extends {
  members: infer M extends object
}
  ? M
  : {}

/** The events the spec `X` declares: payloads by name, without the `handle`
 * Repo adds on delivery. What {@link ExtensionContext.emit} takes. */
export type EventsOf<X extends HandleExtensionSpec> = X extends {
  events: infer E extends object
}
  ? E
  : {}

/** The events the spec `X` adds to a handle of a `T`, as listeners. */
export type ExtensionEvents<T, X extends HandleExtensionSpec> = {
  [N in keyof EventsOf<X>]: (
    payload: EventsOf<X>[N] & { handle: DocHandle<T, X> }
  ) => void
}

/**
 * Adds a backend feature to every handle of a Repo using that backend; see
 * {@link SedimentreeBackend.handleExtensions}. It may only add members, not
 * replace existing ones; what it adds is declared by its backend's
 * {@link HandleExtensionSpec}.
 *
 * `S` is the session the extension needs: it reaches its backend through
 * the document's session, with whatever methods that backend's sessions
 * have, and the backend reaches it with `extension` session events of its
 * kind. A backend's sessions must implement what its extensions need; an
 * extension typed against the backend's own session type has that checked
 * where the backend declares what `open()` returns.
 *
 * `E` is the events the extension emits ({@link ExtensionContext.emit});
 * `P` is the payload of the `extension` events its backend sends it; `X` is
 * what it adds to handles, which {@link provides} reads.
 *
 * An extension is a record of methods. Each takes the document's
 * {@link ExtensionContext}, then the handle it was called on, then the
 * caller's arguments. Getters are not supported. Write one with
 * {@link defineExtension} to check its methods against the spec; a record
 * written by hand states `X` in its type or adds nothing to the handle type.
 *
 * @experimental
 */
export interface HandleExtension<
  S extends SedimentreeSession = SedimentreeSession,
  E extends object = Record<string, unknown>,
  P = unknown,
  X extends HandleExtensionSpec = {},
> {
  readonly kind: string
  /** Type only: never set. */
  readonly "~spec"?: X
  /** The methods added to every handle, by string or symbol name. Each takes
   * the document's context and the handle it was called on first; callers
   * pass neither. */
  readonly members: {
    readonly [name: PropertyKey]: (
      context: ExtensionContext<S, E>,
      handle: DocHandle<unknown, X>,
      ...args: any[]
    ) => unknown
  }
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. */
  receive?(context: ExtensionContext<S, E>, payload: P): void
}

/** A handle extension of any session, event and payload types: how lists of
 * heterogeneous extensions are typed. */
export type AnyHandleExtension = HandleExtension<any, any, any, any>

/** What an extension can do with one document. */
export interface ExtensionContext<
  S extends SedimentreeSession = SedimentreeSession,
  E extends object = Record<string, unknown>,
> {
  readonly documentId: DocumentId
  /** The Repo that owns the document. */
  readonly repoId: RepoId
  /** The document's open session; none before it opens or once it is closed. */
  readonly session: S | undefined
  /** The document's open session, or throws if there is none. For members
   * whose contract is "the document must be open"; best-effort members
   * branch on {@link session} instead. Bound: safe to destructure. */
  requireSession(): S
  /** Emit `event` on every handle of the document listening for it, with
   * the handle added to `payload`. Does nothing once the document is closed
   * or deleted. */
  emit<N extends keyof E & string>(event: N, payload: E[N]): void
  /** Log an error; never throws. */
  log(message: string, detail: unknown): void
}

/** An extension event of any kind, as Repo receives them. */
export interface AnyExtensionEvent {
  readonly type: "extension"
  readonly sequence: number
  readonly kind: string
  readonly payload: unknown
}
