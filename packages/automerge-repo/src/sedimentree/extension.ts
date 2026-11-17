import type { DocHandle } from "../types/DocHandle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"

/**
 * What a backend's handle extensions add to every handle of its Repo, as a
 * type the backend declares with {@link provides}: the members its
 * extensions add and the events they emit. A backend with several
 * extensions declares the intersection of their specs.
 *
 * ```ts
 * interface MySpec {
 *   members: { mine(): string }
 *   events: { "mine-event": { n: number } }
 * }
 * class MyBackend implements SedimentreeBackend<MySpec> {
 *   readonly handleExtensions = provides<MySpec>(mine)
 *   // …
 * }
 * ```
 *
 * The spec is declared, not inferred: it is the backend author's job that it
 * matches what the listed extensions actually add. Members may not depend on
 * the handle's document type.
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
 * `P` is the payload of the `extension` events its backend sends it.
 *
 * An extension is a record of methods taking the document's
 * {@link ExtensionContext} first. Repo installs wrappers on one shared
 * subclass of its handle class. Extensions have no constructors, getters,
 * or per-handle state. Write one with {@link defineExtension} to check its
 * methods against the spec.
 *
 * @experimental
 */
export interface HandleExtension<
  S extends SedimentreeSession = SedimentreeSession,
  E extends object = Record<string, unknown>,
  P = unknown,
> {
  readonly kind: string
  /** The methods added to every handle, by string or symbol name. Each takes
   * the handle's document context first; callers do not pass it. */
  readonly members: {
    readonly [name: PropertyKey]: (
      context: ExtensionContext<S, E>,
      ...args: any[]
    ) => unknown
  }
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. */
  receive?(context: ExtensionContext<S, E>, payload: P): void
}

/** A handle extension of any session, event and payload types: how lists of
 * heterogeneous extensions are typed. */
export type AnyHandleExtension = HandleExtension<any, any, any>

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
