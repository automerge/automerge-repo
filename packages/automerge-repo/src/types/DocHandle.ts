// The public `DocHandle`: the class, and the type of a handle of a given doc
// type with the members its Repo's backend adds. Import `DocHandle` from
// here, not from `../Handle.js`, whose class type lacks those members.
import { Handle, handleState, type AnyHandle } from "../Handle.js"
import type { AutomergeDocType } from "../automerge/docType.js"
import type {
  AnyDocType,
  DocType,
  HandleClass,
  Shaped,
  ShapedHandle,
  ShapedOf,
} from "../DocType.js"
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

/** What of a backend spec a handle can see: its members and events. A
 * handle records only these, so two specs that differ elsewhere (`session`,
 * `receives`) give the same handle type. */
// Distributive, so it gives a fresh object type: two specs with the same
// members and events then give identical handle types, rather than being
// compared by their type arguments.
export type VisibleSpec<X extends HandleExtensionSpec> = X extends unknown
  ? { readonly members?: ExtensionMembers<X>; readonly events?: EventsOf<X> }
  : never

/** The handle `H` with the backend extensions `X`: their members and events. */
export type WithBackend<H, X extends HandleExtensionSpec> = H & {
  readonly "~ext": VisibleSpec<X>
} & ExtensionMembers<X> &
  ExtensionEventsApi<VisibleSpec<X>, H>

/**
 * Another handle, from the same backend as `This`. A handle class's method
 * returning a different handle (a sub-handle, say) uses it, so the result
 * keeps the backend's members: `sub(key): SameBackend<this, MyHandle<T[K]>>`.
 */
export type SameBackend<
  This extends AnyHandle,
  H extends AnyHandle,
> = WithBackend<H, This["~ext"]>

/** A handle of a document of any type: the core API, loosely typed. */
export interface AnyDocHandle<
  X extends HandleExtensionSpec = {},
> extends Handle<any, any, any> {
  readonly "~ext": VisibleSpec<X>
  doc(): any
  change(change: any, options?: any): Promise<void>
}

type ValueOf<D> =
  D extends DocType<any, infer V, any, any, any, any> ? V : unknown
type ChangeOf<D> =
  D extends DocType<any, any, infer C, any, any, any> ? C : unknown

/** The handle a doc type makes for shape `T` on a backend with extensions
 * `X`, before those extensions' members: its class (applied to `T` and `X`
 * if the type is {@link Shaped}), or the base `Handle` typed from the doc
 * type's `value` and `change`. */
export type HandleOfType<
  D extends AnyDocType,
  T = unknown,
  X extends HandleExtensionSpec = {},
> =
  ShapedOf<D> extends infer K extends Shaped
    ? ShapedHandle<K, T, X>
    : D extends DocType<any, any, any, any, any, infer C>
      ? C extends HandleClass
        ? InstanceType<C>
        : Handle<ValueOf<D>, ChangeOf<D>>
      : Handle<ValueOf<D>, ChangeOf<D>>

/** The core handle with backend extensions `X` (no doc-type-only members). */
export type CoreHandle<X extends HandleExtensionSpec = {}> = WithBackend<
  Handle,
  X
>

/**
 * A handle to one document: its doc type's handle class, for documents of
 * shape `T`, with the members and events its Repo's backend adds (see
 * {@link HandleExtensionSpec}). `X` is the backend's spec and `D` the doc
 * type, Automerge by default. `DocHandle<any, X, AnyDocType>` is a handle of
 * any type.
 */
export type DocHandle<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> = ([AnyDocType] extends [D] ? AnyDocHandle<X> : HandleOfType<D, T, X>) & {
  readonly "~ext": VisibleSpec<X>
} & ExtensionMembers<X> &
  // Written out rather than as `WithBackend<…>`, so TypeScript shows the type
  // by this name.
  ExtensionEventsApi<
    VisibleSpec<X>,
    [AnyDocType] extends [D] ? AnyDocHandle<X> : HandleOfType<D, T, X>
  >

/** The class of every handle, for `instanceof`. */
export const DocHandle = Handle

/** Whether `handle` is of the doc type `type` (compared by scheme). Keeps
 * the backend's extensions the handle was typed with. */
export function isHandleOf<E extends HandleExtensionSpec, D extends AnyDocType>(
  handle: { readonly "~ext": E },
  type: D
): handle is { readonly "~ext": E } & DocHandle<unknown, E, D> {
  return handleState(handle as unknown as AnyHandle).type.scheme === type.scheme
}
