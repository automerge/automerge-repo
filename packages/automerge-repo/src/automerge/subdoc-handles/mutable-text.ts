import * as Automerge from "@automerge/automerge/slim"
import type { Prop } from "@automerge/automerge/slim"
import type { MutableText as IMutableText } from "./types.js"

/**
 * Wrap a string value in a {@link IMutableText} editor for a `change` callback.
 *
 * The returned value is a genuine boxed `String` (`new String(value)`), so it
 * behaves as a real string everywhere - `instanceof String`, `.length`,
 * indexing, iteration, and every `String.prototype` method work natively, and
 * `valueOf()` returns the primitive. No `Proxy`, no prototype spoofing.
 *
 * A boxed `String` (unlike a primitive) can carry properties, so we attach the
 * CRDT-safe `splice` / `updateText` methods to it (non-enumerable, so they
 * don't surface in spreads / `JSON.stringify`). The String itself is inert with
 * respect to Automerge - it's a snapshot of the value at callback entry; the
 * methods address the live text by the captured `(doc, path)`.
 *
 * When `range` is provided the editor is scoped to a sub-span of the field:
 * indices are relative to the substring (and clamped into it), and `updateText`
 * replaces only that span.
 */
export function MutableText(
  doc: Automerge.Doc<unknown>,
  path: Prop[],
  value: string,
  range?: { start: number }
): IMutableText {
  const start = range?.start ?? 0
  const len = value.length

  const boxed = new String(value)

  Object.defineProperties(boxed, {
    splice: {
      value(index: number, deleteCount: number, insert = ""): void {
        // Clamp into [0, len] so a range-scoped editor can't reach outside its
        // own span (and a full-string editor is just clamped to its length).
        const i = Math.max(0, Math.min(index, len))
        const d = Math.max(0, Math.min(deleteCount, len - i))
        Automerge.splice(doc, path, start + i, d, insert)
      },
      enumerable: false,
    },
    updateText: {
      value(newValue: string): void {
        if (range) {
          // Replace just this span - splice the new value over [start, start+len).
          Automerge.splice(doc, path, start, len, newValue)
        } else {
          Automerge.updateText(doc, path, newValue)
        }
      },
      enumerable: false,
    },
  })

  return boxed as unknown as IMutableText
}
