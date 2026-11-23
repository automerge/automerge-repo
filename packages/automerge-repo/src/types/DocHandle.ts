// The public `DocHandle`: the class, and the type of a handle of a given doc
// type with the members its Repo's backend adds. Import `DocHandle` from
// here, not from `../Handle.js`, whose class type lacks those members.
import {
  Handle,
  handleState,
  type AnyHandle,
  type HandleEventApi,
} from "../Handle.js"
import type { AutomergeHandle } from "../automerge/handle.js"
import type { AutomergeDocType } from "../automerge/docType.js"
import type { AnyDocType, DocType, HandleClass } from "../DocType.js"
import type {
  EventsOf,
  ExtensionMembers,
  HandleExtensionSpec,
} from "../sedimentree/extension.js"

/** The handle-visible slice of an extension spec (drops session/receives). */
type HandleVisibleSpec<X extends HandleExtensionSpec> = {
  readonly members: ExtensionMembers<X>
  readonly events: EventsOf<X>
}

/** A handle's own event names, read from its `Handle` base. */
type EventNamesOf<H> =
  H extends Handle<any, any, infer E> ? keyof E & string : never

/** Extension events `X` declares, with `handle` added to each payload. */
type ExtensionEventMap<X extends HandleExtensionSpec, H> = {
  [N in keyof EventsOf<X> & string]: (
    payload: EventsOf<X>[N] & { handle: H }
  ) => void
}

/**
 * Listener methods for a backend extension spec `X`'s events, layered onto a
 * doc type's handle `H`. No conditional on `X`, so generic code over `X`
 * stays callable.
 */
export type ExtensionEventsApi<
  X extends HandleExtensionSpec,
  H,
> = HandleEventApi<ExtensionEventMap<X, H>> & {
  eventNames(): (
    | EventNamesOf<H>
    | (keyof EventsOf<X> & string)
    | (string & {})
  )[]
}

/** A handle of a document of any type: the core API, loosely typed. */
export interface AnyDocHandle<
  X extends HandleExtensionSpec = {},
> extends Handle<any, any, any> {
  /** Type-only: preserves the handle-visible extension spec for `isHandleOf`. */
  readonly "~ext"?: HandleVisibleSpec<X>
  doc(): any
  change(change: any, options?: any): Promise<void>
}

type ValueOf<D> =
  D extends DocType<any, infer V, any, any, any, any> ? V : unknown
type ChangeOf<D> =
  D extends DocType<any, any, infer C, any, any, any> ? C : unknown

/** The handle a doc type makes before backend extensions: its class, or
 * the base `Handle` typed from the doc type's `value` and `change`. */
export type HandleOfType<D extends AnyDocType> =
  D extends DocType<any, any, any, any, any, infer C>
    ? C extends HandleClass
      ? InstanceType<C>
      : Handle<ValueOf<D>, ChangeOf<D>>
    : Handle<ValueOf<D>, ChangeOf<D>>

/** The core handle with backend extensions `X` (no doc-type-only members). */
export type CoreHandle<X extends HandleExtensionSpec = {}> = Handle &
  ExtensionMembers<X> &
  ExtensionEventsApi<X, Handle & ExtensionMembers<X>>

/**
 * A handle to one document: its doc type's handle class, and the members and
 * events its Repo's backend adds (see {@link HandleExtensionSpec}). `T` is an
 * Automerge document's shape, `X` the backend's spec and `D` the doc type,
 * Automerge by default. `DocHandle<any, X, AnyDocType>` is a handle of any
 * type.
 */
export type DocHandle<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> = [AnyDocType] extends [D]
  ? AnyDocHandle<X> & ExtensionMembers<X>
  : D extends AutomergeDocType
    ? AutomergeHandle<T, X> & ExtensionMembers<X>
    : HandleOfType<D> &
        ExtensionMembers<X> &
        ExtensionEventsApi<X, HandleOfType<D> & ExtensionMembers<X>>

/** The class of every handle, for `instanceof`. */
export const DocHandle = Handle

/** Whether `handle` is of the doc type `type` (compared by scheme). */
export function isHandleOf<X extends HandleExtensionSpec, D extends AnyDocType>(
  handle: AnyDocHandle<X>,
  type: D
): handle is DocHandle<unknown, X, D>
export function isHandleOf<D extends AnyDocType>(
  handle: AnyHandle,
  type: D
): handle is DocHandle<unknown, {}, D>
export function isHandleOf(handle: AnyHandle, type: AnyDocType): boolean {
  return handleState(handle).type.scheme === type.scheme
}
