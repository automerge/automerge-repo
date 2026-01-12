import * as Automerge from "@automerge/automerge";
import type { Prop } from "@automerge/automerge";
import type { MutableText as IMutableText } from "./types.js";

/**
 * Create a MutableText wrapper that provides Automerge string mutations.
 *
 * Uses a Proxy to forward all standard string methods to the underlying value
 * while adding Automerge-specific mutation methods (splice, updateText).
 */
export function MutableText(
  doc: Automerge.Doc<unknown>,
  propPath: Prop[],
  value: string
): IMutableText {
  const mutations = {
    splice(index: number, deleteCount: number, insert?: string): void {
      Automerge.splice(doc, propPath, index, deleteCount, insert);
    },
    updateText(newValue: string): void {
      Automerge.updateText(doc, propPath, newValue);
    },
  };

  return new Proxy(mutations, {
    get(target, prop) {
      // Automerge mutation methods
      if (prop in target) {
        return target[prop as keyof typeof target];
      }

      // Forward to underlying string
      const stringValue = value as unknown as Record<string | symbol, unknown>;
      const member = stringValue[prop];

      // Bind functions to the string value
      return typeof member === "function" ? member.bind(value) : member;
    },

    // Support iteration (for...of, spread)
    getPrototypeOf() {
      return String.prototype;
    },
  }) as IMutableText;
}
