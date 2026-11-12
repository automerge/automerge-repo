import type { DocHandle } from "../DocHandle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"

/** A handle class, as extensions see it. */
export type HandleClass = new (...args: any[]) => DocHandle<any>

/**
 * Adds a backend feature to every handle of a Repo using that backend; see
 * {@link SedimentreeBackend.handleExtensions}. It may only add members, not
 * replace existing ones, and must describe what it adds in
 * {@link HandleExtensionTypes}.
 *
 * `S` is the session the extension needs: it reaches its backend through
 * the document's session, with whatever methods that backend's sessions
 * have, and the backend reaches it with `extension` session events of its
 * kind. A backend's sessions must implement what its extensions need; an
 * extension typed against the backend's own session type has that checked
 * where the backend declares what `open()` returns.
 *
 * @experimental
 */
export interface HandleExtension<
  K extends string = string,
  S extends SedimentreeSession = any,
> {
  readonly kind: K
  /** Returns a subclass of `base` with this extension's members; `context`
   * gives a handle's document. */
  extend(
    base: HandleClass,
    context: (handle: DocHandle<any>) => ExtensionContext<S>
  ): HandleClass
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. */
  receive?(context: ExtensionContext<S>, payload: ExtensionInbound<K>): void
}

/** What an extension can do with one document. */
export interface ExtensionContext<
  S extends SedimentreeSession = SedimentreeSession,
> {
  readonly documentId: DocumentId
  /** The Repo that owns the document. */
  readonly repoId: RepoId
  /** The document's open session; none before it opens or once it is closed. */
  readonly session: S | undefined
  /** Emit `event` on every handle of the document listening for it. Does
   * nothing once the document is closed or deleted. */
  emit(event: string, payload: (handle: DocHandle<any>) => unknown): void
  /** Log an error; never throws. */
  log(message: string, detail: unknown): void
}

/**
 * What each extension kind adds to a handle of a `T`, and what its backend
 * sends it. Packages providing an extension declare it here by module
 * augmentation:
 *
 * ```ts
 * declare module "@automerge/automerge-repo/sedimentree" {
 *   interface HandleExtensionTypes<T> {
 *     mine: { members: MyMembers; events: MyEvents<T>; inbound: MyInbound }
 *   }
 * }
 * ```
 */
// Augmentations must repeat the parameter, so it is declared though unused.
// eslint-disable-next-line no-unused-vars
export interface HandleExtensionTypes<T> {}

/** The payload of the `extension` events a backend sends extension `K`. */
export type ExtensionInbound<K extends string> =
  K extends keyof HandleExtensionTypes<unknown>
    ? HandleExtensionTypes<unknown>[K] extends { inbound: infer I }
      ? I
      : unknown
    : unknown

/**
 * A session event for a handle extension, by kind: a backend can only send
 * the kinds some extension has declared, with that extension's payload.
 */
export type ExtensionEvent = {
  [K in keyof HandleExtensionTypes<unknown>]: {
    readonly type: "extension"
    readonly sequence: number
    readonly kind: K
    readonly payload: ExtensionInbound<K>
  }
}[keyof HandleExtensionTypes<unknown>]

/** An extension event of a kind not known here, for code that only passes
 * them on. */
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

type Added<
  T,
  K extends string,
  P extends "members" | "events",
> = K extends keyof HandleExtensionTypes<T>
  ? HandleExtensionTypes<T>[K] extends { [_ in P]: infer V }
    ? V
    : never
  : never

/** The members extensions `K` add to a handle of a `T`. */
export type ExtensionMembers<T, K extends string> = UnionToIntersection<
  Added<T, K, "members">
>

/** The events extensions `K` add to a handle of a `T`. */
export type ExtensionEvents<T, K extends string> = UnionToIntersection<
  Added<T, K, "events">
>
