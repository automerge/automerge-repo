// The public `DocHandle`: the class, and the type of a handle of a given doc
// type with the members its Repo's backend adds. Import `DocHandle` from
// here, not from `../Handle.js`, whose class type lacks those members.
import { Handle, handleState } from "../Handle.js"
import type { AutomergeHandle } from "../automerge/handle.js"
import type { AutomergeDocType } from "../automerge/docType.js"
import type { AnyDocType, DocType } from "../DocType.js"
import type {
  ExtensionMembers,
  HandleExtensionSpec,
} from "../sedimentree/extension.js"

/** A handle of a document of any type: the core API, loosely typed. */
export interface AnyDocHandle<
  X extends HandleExtensionSpec = {},
> extends Handle<any, X, any> {
  doc(): any
  change(change: any, options?: any): Promise<void>
}

/** The handle a doc type's class makes, before backend extensions. */
export type HandleOfType<D extends AnyDocType> =
  D extends DocType<any, any, any, any, any, infer C>
    ? InstanceType<C>
    : Handle<unknown>

/**
 * A handle to one document: its doc type's handle class, and the members
 * its Repo's backend adds (see {@link HandleExtensionSpec}). `T` is an
 * Automerge document's shape, `X` the backend's spec and `D` the doc type,
 * Automerge by default. `DocHandle<any, X, AnyDocType>` is a handle of any
 * type.
 */
export type DocHandle<
  T,
  X extends HandleExtensionSpec = {},
  D extends AnyDocType = AutomergeDocType,
> = ([AnyDocType] extends [D]
  ? AnyDocHandle<X>
  : D extends AutomergeDocType
    ? AutomergeHandle<T, X>
    : HandleOfType<D>) &
  ExtensionMembers<X>

/** The class of every handle, for `instanceof`. */
export const DocHandle = Handle

/** Whether `handle` is of the doc type `type` (compared by scheme). */
export function isHandleOf<X extends HandleExtensionSpec, D extends AnyDocType>(
  handle: Handle<any, X, any>,
  type: D
): handle is DocHandle<unknown, X, D> {
  return handleState(handle).type.scheme === type.scheme
}
