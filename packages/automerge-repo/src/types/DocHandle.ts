// The public `DocHandle`: the class, and its type with the members its
// Repo's backend adds. Import `DocHandle` from here, not from
// `../DocHandle.js`, whose class type lacks the extension members.
import { DocHandle as DocHandleClass } from "../DocHandle.js"
import type {
  ExtensionMembers,
  HandleExtensionSpec,
} from "../sedimentree/extension.js"

/**
 * A handle to one document: the {@link DocHandleClass} members, and those
 * its Repo's backend adds (see {@link HandleExtensionSpec}). `X` is that
 * backend's spec; a plain Repo's handles have none.
 */
export type DocHandle<T, X extends HandleExtensionSpec = {}> = DocHandleClass<
  T,
  X
> &
  ExtensionMembers<X>

/** The class, for `instanceof` and subclassing. */
export const DocHandle = DocHandleClass
