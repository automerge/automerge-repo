import type { DocHandle, ExtendedHandle } from "../DocHandle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"

/** A handle class, as extensions see it. */
export type HandleClass = new (...args: any[]) => DocHandle<any>

/**
 * What an extension adds to a handle, and what its backend sends it. Each
 * extension declares its own, as an interface extending this one:
 *
 * ```ts
 * interface MyTypes extends ExtensionTypes {
 *   kind: "mine"
 *   members: MyMembers<this["T"]>
 *   events: { "mine-event": { n: number } }
 *   inbound: MyInbound
 * }
 * ```
 *
 * `this["T"]` is the document type of the handle the extension is on,
 * filled in by Repo for each handle. It cannot be written inside an inline
 * object or function type, so a member or event that depends on it goes
 * through a named generic interface, like `MyMembers<T>` above.
 *
 * @experimental
 */
export interface ExtensionTypes {
  /** The handle's document type; see {@link ExtensionTypes}. */
  readonly T: unknown
  readonly kind: string
  /** The methods and getters it adds to a handle. */
  readonly members: object
  /** Its events' payloads by name. Each also carries the `handle` it is
   * emitted on, which Repo adds. */
  readonly events: object
  /** The payload of the `extension` events its backend sends it. */
  readonly inbound: unknown
}

/** `Types` for a handle of a `T`. */
type Apply<Types extends ExtensionTypes, T> = Types extends unknown
  ? Types & { readonly T: T }
  : never

/** The types of the extensions `X`, a union of extension values' types. */
export type TypesOf<X> = X extends {
  readonly "~types"?: infer Types extends ExtensionTypes
}
  ? Types
  : never

/**
 * Adds a backend feature to every handle of a Repo using that backend; see
 * {@link SedimentreeBackend.handleExtensions}. It may only add members, not
 * replace existing ones, and describes what it adds in `Types`; see
 * {@link ExtensionTypes}.
 *
 * `S` is the session the extension needs: it reaches its backend through
 * the document's session, with whatever methods that backend's sessions
 * have, and the backend reaches it with `extension` session events of its
 * kind. A backend's sessions must implement what its extensions need; an
 * extension typed against the backend's own session type has that checked
 * where the backend declares what `open()` returns.
 *
 * Declare an extension with this type, rather than `satisfies` it, so that
 * its type carries `Types`.
 *
 * @experimental
 */
export interface HandleExtension<
  Types extends ExtensionTypes = ExtensionTypes,
  S extends SedimentreeSession = any,
> {
  readonly kind: Types["kind"]
  /** Returns a subclass of `base` with this extension's members; `context`
   * gives a handle's document. */
  extend(
    base: HandleClass,
    context: (handle: DocHandle<any>) => ExtensionContext<S, Types>
  ): HandleClass
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. */
  receive?(context: ExtensionContext<S, Types>, payload: Types["inbound"]): void
  /** Type only: never set. */
  readonly "~types"?: Types
}

/** What an extension can do with one document. */
export interface ExtensionContext<
  S extends SedimentreeSession = SedimentreeSession,
  Types extends ExtensionTypes = ExtensionTypes,
> {
  readonly documentId: DocumentId
  /** The Repo that owns the document. */
  readonly repoId: RepoId
  /** The document's open session; none before it opens or once it is closed. */
  readonly session: S | undefined
  /** Emit `event` on every handle of the document listening for it, with
   * the handle added to `payload`. Does nothing once the document is closed
   * or deleted. */
  emit<N extends keyof Apply<Types, unknown>["events"] & string>(
    event: N,
    payload: Apply<Types, unknown>["events"][N]
  ): void
  /** Log an error; never throws. */
  log(message: string, detail: unknown): void
}

/**
 * A session event for the handle extensions `X`, by kind: a backend can only
 * send its own extensions' kinds, with their payloads.
 */
export type ExtensionEvent<X extends HandleExtension> =
  TypesOf<X> extends infer Types extends ExtensionTypes
    ? Types extends unknown
      ? {
          readonly type: "extension"
          readonly sequence: number
          readonly kind: Types["kind"]
          readonly payload: Types["inbound"]
        }
      : never
    : never

/** An extension event of any kind, as Repo receives them. */
export interface AnyExtensionEvent {
  readonly type: "extension"
  readonly sequence: number
  readonly kind: string
  readonly payload: unknown
}

type UnionToIntersection<U> = (
  U extends unknown ? (u: U) => void : never
) extends (i: infer I) => void
  ? I
  : never

/** The members extensions `X` add to a handle of a `T`. */
export type ExtensionMembers<
  T,
  X extends HandleExtension,
> = UnionToIntersection<Apply<TypesOf<X>, T>["members"]>

type EventsOf<T, X extends HandleExtension, Types extends ExtensionTypes> = {
  [N in keyof Types["events"]]: (
    payload: Types["events"][N] & { handle: ExtendedHandle<T, X> }
  ) => void
}

/** The events extensions `X` add to a handle of a `T`. */
export type ExtensionEvents<T, X extends HandleExtension> = UnionToIntersection<
  Apply<TypesOf<X>, T> extends infer Types extends ExtensionTypes
    ? Types extends unknown
      ? EventsOf<T, X, Types>
      : never
    : never
>
