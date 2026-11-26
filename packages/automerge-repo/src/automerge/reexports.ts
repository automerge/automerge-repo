import { next as Automerge, type ObjID } from "@automerge/automerge/slim"

// Automerge re-exports
//
// Note that we can't use export type { .. } from "@automerge/automerge" because we are
// importing automerge like this:
//
// import { next as Automerge } from "@automerge/automerge"
//
// I.e. we are using the `next` export from Automerge. Not the module itself. This is
// to maintain compatiblity with Automerge 3.0 and 2.0. In 2.0 we used to have a
// subpath export at `/next` so the re-exports looked like this:
//
// export { type .. } from "@automerge/automerge/slim/next"
//
// However, we have now removed the subpath export (and deprecated next generally)
// so we need to explicitly name each type we are re-exporting here.
export const Counter = Automerge.Counter
export const RawString = Automerge.RawString
// In automerge 3.0 RawString is renamed to ImmutableString
export const ImmutableString = Automerge.RawString

// Export separate RawString and ImmutableString types,
// whose symbols are only usable as values otherwise.
export type RawString = InstanceType<typeof Automerge.RawString>
export type ImmutableString = RawString

export type Counter = Automerge.Counter
export type Doc<T> = Automerge.Doc<T>
export type Heads = Automerge.Heads
export type Patch = Automerge.Patch
export type PatchCallback<T> = Automerge.PatchCallback<T>
export type Prop = Automerge.Prop
export type ActorId = Automerge.ActorId
export type Change = Automerge.Change
export type ChangeFn<T> = Automerge.ChangeFn<T>
export type Mark = Automerge.Mark
export type MarkSet = Automerge.MarkSet
export type MarkRange = Automerge.MarkRange
export type MarkValue = Automerge.MarkValue
export type Cursor = Automerge.Cursor

// export a few utility functions that aren't in automerge-repo
// NB that these should probably all just be available via the dochandle
export const getChanges = Automerge.getChanges
export const getAllChanges = Automerge.getAllChanges
export const applyChanges = Automerge.applyChanges
export const view = Automerge.view
export const getConflicts = Automerge.getConflicts

// export type-specific utility functions
// these mostly can't be on the data-type in question because
// JS strings can't have methods added to them
export const getCursor = Automerge.getCursor
export const getCursorPosition = Automerge.getCursorPosition
export const splice = Automerge.splice
export const updateText = Automerge.updateText
export const insertAt = Automerge.insertAt
export const deleteAt = Automerge.deleteAt
export const mark = Automerge.mark
export const unmark = Automerge.unmark
export const isRawString = Automerge.isRawString
// In Automerge 3.0 raw string is renamed to immutable string
export const isImmutableString = Automerge.isRawString

export const getObjectId = Automerge.getObjectId
export type { ObjID }
