import type { DocHandle } from "../types/DocHandle.js"
import type { DocumentId, RepoId } from "../types.js"
import type { SedimentreeSession } from "./backend.js"
import type { SedimentreeId } from "./ids.js"

/**
 * Everything about one handle extension's types: its kind, what its backend
 * sends it, the members it adds to handles and the events it emits on them.
 * Each extension carries its own spec (see {@link defineExtension});
 * {@link provides} combines those of the extensions a backend lists.
 *
 * ```ts
 * interface MySpec {
 *   kind: "mine"
 *   inbound: { n: number }
 *   members: { mine(): string }
 *   events: { "mine-event": { n: number } }
 * }
 * const mine = defineExtension<MySession, MySpec>({ … })
 * class MyBackend implements SedimentreeBackend<HandleFeatures<MySpec>> {
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
  /** The extension's kind, as its backend's `extension` events name it. */
  readonly kind?: string
  /** The payload of the `extension` events its backend sends it. */
  readonly inbound?: unknown
  /** The methods added to a handle. */
  readonly members?: object
  /** Added events' payloads by name. Each also carries the `handle` it is
   * emitted on, which Repo adds. */
  readonly events?: object
}

/** What the spec `X` adds to handles: the members and events it declares.
 * Kinds and inbound payloads belong to each extension, so a backend's
 * combined spec leaves them out. */
export type HandleFeatures<X extends HandleExtensionSpec> = (X extends {
  members: infer M extends object
}
  ? { readonly members: M }
  : {}) &
  (X extends { events: infer E extends object } ? { readonly events: E } : {})

/** The kind the spec `X` declares; any string if it declares none. */
export type KindOf<X extends HandleExtensionSpec> = X extends {
  kind: infer K extends string
}
  ? K
  : string

/** The payload the spec `X`'s backend sends it; `unknown` if undeclared. */
export type InboundOf<X extends HandleExtensionSpec> = X extends {
  inbound: infer P
}
  ? P
  : unknown

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
 * replace existing ones.
 *
 * `S` is the session the extension needs: it reaches its backend through
 * the document's session, and the backend reaches it with `extension`
 * session events of its kind. Name only what this extension calls; a
 * backend's session is then worked out from its extensions (see
 * {@link SessionFor}). `X` is the extension's {@link HandleExtensionSpec}.
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
  X extends HandleExtensionSpec = {},
> {
  /** The spec's kind, as its backend's `extension` events name it. */
  readonly kind: KindOf<X>
  /** Type only: never set. */
  readonly "~spec"?: X
  /** Type only: never set. The session this extension needs. */
  readonly "~session"?: (session: S) => void
  /** The methods added to every handle, by string or symbol name. Each takes
   * the document's context and the handle it was called on first; callers
   * pass neither. */
  readonly members: {
    readonly [name: PropertyKey]: (
      context: ExtensionContext<S, EventsOf<X>>,
      handle: DocHandle<unknown, HandleFeatures<X>>,
      ...args: any[]
    ) => unknown
  }
  /** The backend sent `payload`: a session event `{ type: "extension" }` of
   * this kind. Synchronous: Repo does not wait for it. */
  readonly receive?: (
    context: ExtensionContext<S, EventsOf<X>>,
    payload: InboundOf<X>
  ) => void
}

/** A handle extension of any session and spec: how lists of heterogeneous
 * extensions are typed. */
export type AnyHandleExtension = HandleExtension<any, any>

/** What an extension can do with one document. */
export interface ExtensionContext<
  S extends SedimentreeSession = SedimentreeSession,
  E extends object = Record<string, unknown>,
> {
  readonly documentId: DocumentId
  /** The document's ID as the backend knows it. */
  readonly sedimentreeId: SedimentreeId
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

/** A session event of kind `K` from a backend to its extension, whose
 * `receive` gets `payload`. */
export interface ExtensionEvent<K extends string = string, P = unknown> {
  readonly type: "extension"
  readonly sequence: number
  readonly kind: K
  readonly payload: P
}

/** An extension event of any kind, as Repo receives them. */
export type AnyExtensionEvent = ExtensionEvent
