import type {
  AnyDocType,
  AnyHandleKind,
  DocHandle,
  Of,
  Repo,
} from "@automerge/automerge-repo/slim"

export interface UseDocHandleOptions {
  repo?: Repo
  // @internal
  "~skipInitialValue"?: boolean
}

export type MaybeAccessor<T> = T | (() => T)

/** The options of a primitive opening a document of the doc type `D`, for
 * documents of shape `S`: as `repo.find`'s `{ docType }`. */
export type DocTypeOptions<D, S> = { docType: Of<D, S> }

/** @internal A handle of a document of any type. */
export type AnyHandle = DocHandle<any, {}, AnyHandleKind>

/** @internal What the primitives take, at runtime. */
export type AnyOptions = UseDocHandleOptions & { docType?: AnyDocType }

/** What a handle's `doc()` returns: its document's value. */
export type ValueOf<H> = H extends { doc(): infer V } ? V : never
