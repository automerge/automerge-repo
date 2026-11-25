// The public `DocHandle`: the class, and the type of a handle of a given doc
// type with the members its Repo's backend adds. Import `DocHandle` from
// here, not from `../Handle.js`, whose class type lacks those members.
import { Handle, handleState, type AnyHandle } from "../Handle.js"
import type { AutomergeKind } from "../automerge/docType.js"
import type { AnyDocType, HandleFor, HandleKind, KindOf } from "../DocType.js"
import type {
  EventsOf,
  ExtensionMembers,
  HandleExtensionSpec,
} from "../sedimentree/extension.js"

/** A handle's own event names, read from its `Handle` base. */
type EventNamesOf<H> =
  H extends Handle<any, any, infer E> ? keyof E & string : never

/** The payload of the backend event `K`, delivered on handle `H`. */
type ExtensionPayload<
  X extends HandleExtensionSpec,
  K extends keyof EventsOf<X>,
  H,
> = EventsOf<X>[K] & { handle: H }

/**
 * Listener methods for a backend's events, on whatever handle they are part
 * of: payloads carry that whole handle (`this`). `H` is the handle before the
 * backend's members, for `eventNames` (through `this` it would be circular).
 */
export interface ExtensionEventsApi<
  X extends HandleExtensionSpec,
  H = unknown,
> {
  on<K extends keyof EventsOf<X> & string>(
    event: K,
    fn: (payload: ExtensionPayload<X, K, this>) => void
  ): this
  addListener<K extends keyof EventsOf<X> & string>(
    event: K,
    fn: (payload: ExtensionPayload<X, K, this>) => void
  ): this
  once<K extends keyof EventsOf<X> & string>(
    event: K,
    fn: (payload: ExtensionPayload<X, K, this>) => void
  ): this
  off<K extends keyof EventsOf<X> & string>(event: K): this
  off<K extends keyof EventsOf<X> & string>(
    event: K,
    fn: ((payload: ExtensionPayload<X, K, this>) => void) | undefined
  ): this
  removeListener<K extends keyof EventsOf<X> & string>(event: K): this
  removeListener<K extends keyof EventsOf<X> & string>(
    event: K,
    fn: ((payload: ExtensionPayload<X, K, this>) => void) | undefined
  ): this
  removeAllListeners<K extends keyof EventsOf<X> & string>(event?: K): this
  listenerCount<K extends keyof EventsOf<X> & string>(event: K): number
  listeners<K extends keyof EventsOf<X> & string>(
    event: K
  ): ((payload: ExtensionPayload<X, K, this>) => void)[]
  emit<K extends keyof EventsOf<X> & string>(
    event: K,
    payload: ExtensionPayload<X, K, this>
  ): boolean
  eventNames(): (
    | EventNamesOf<H>
    | (keyof EventsOf<X> & string)
    | (string & {})
  )[]
}

/** What of a backend spec a handle's events see: its members and events. */
// Distributive, so it gives a fresh object type: two specs with the same
// members and events then give identical event methods, rather than being
// compared by their type arguments.
export type VisibleSpec<X extends HandleExtensionSpec> = X extends unknown
  ? { readonly members?: ExtensionMembers<X>; readonly events?: EventsOf<X> }
  : never

/** The handle `H` with the backend extensions `X`: their members and events. */
export type WithBackend<H, X extends HandleExtensionSpec> = H & {
  readonly "~spec"?: X
} & ExtensionMembers<X> &
  ExtensionEventsApi<VisibleSpec<X>, H>

/**
 * The backend extension spec of the handle `H`. A handle class's method
 * returning a different handle passes it on, so the result keeps the
 * backend's members and events: `DocHandle<T[K], BackendOf<this>, MyKind>`.
 */
export type BackendOf<H extends AnyHandle> = NonNullable<H["~spec"]>

/**
 * Another handle, from the same backend as `This`, without naming its doc
 * type: `part(key): SameBackend<this, MyHandle<T[K]>>`. Prefer
 * `DocHandle<…, BackendOf<this>, MyKind>`, which shows by name.
 */
export type SameBackend<
  This extends AnyHandle,
  H extends AnyHandle,
> = WithBackend<H, BackendOf<This>>

/** A handle of a document of any type: the core API, loosely typed. */
export interface AnyDocHandle extends Handle<any, any, any> {
  doc(): any
  change(change: any, options?: any): Promise<void>
}

/** The handles of a document of any type: the core API, loosely typed.
 * `DocHandle<any, X, AnyHandleKind>` is what `repo.handles` lists. */
export interface AnyHandleKind extends HandleKind {
  readonly handle: AnyDocHandle
}

/** The core handle with backend extensions `X` (no doc-type-only members). */
export type CoreHandle<X extends HandleExtensionSpec = {}> = WithBackend<
  Handle,
  X
>

/**
 * A handle to one document, of shape `T`, on a backend with extensions `X`
 * (see {@link HandleExtensionSpec}): the doc type's handle as its
 * {@link HandleKind} `K` says, with the backend's members and events. `K` is
 * Automerge's by default; `DocHandle<any, X, AnyHandleKind>` is a handle of
 * any type.
 */
// Written out rather than as `WithBackend<…>`, so TypeScript shows the type by
// this name.
export type DocHandle<
  T,
  X extends HandleExtensionSpec = {},
  K extends HandleKind = AutomergeKind,
> = HandleFor<K, T> & {
  readonly "~scheme": K["scheme"]
  readonly "~spec"?: X
} & ExtensionMembers<X> &
  ExtensionEventsApi<VisibleSpec<X>, HandleFor<K, T>>

/** The class of every handle, for `instanceof`. */
export const DocHandle = Handle

/** Whether `handle` is of the doc type `type` (compared by scheme). Keeps
 * the backend's extensions the handle was typed with. */
export function isHandleOf<S extends HandleExtensionSpec, D extends AnyDocType>(
  handle: { readonly "~spec"?: S },
  docType: D
): handle is { readonly "~spec"?: S } & DocHandle<unknown, S, KindOf<D>> {
  return (
    handle instanceof Handle &&
    handleState(handle).docType.scheme === docType.scheme
  )
}
