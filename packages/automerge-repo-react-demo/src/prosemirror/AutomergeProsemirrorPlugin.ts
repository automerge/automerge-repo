import * as Automerge from "automerge-js"
import { Doc } from "automerge-js"
import { DocHandle } from "automerge-repo"
import { PluginKey, Plugin, EditorState } from "prosemirror-state"
import { convertAutomergeTransactionToProsemirrorTransaction } from "./automerge/AutomergeToProsemirrorTransaction"
import { TextKeyOf } from "./automerge/AutomergeTypes"
import { prosemirrorTransactionToAutomerge } from "./automerge/ProsemirrorTransactionToAutomerge"
import { attributedTextChanges } from "./RichTextUtils"

export interface AutomergePluginState {
  heads: string[]
}

export const automergePluginKey = new PluginKey<AutomergePluginState>(
  "automergeProsemirror"
)

export const automergePlugin = <T>(
  handle: DocHandle<T>,
  attribute: TextKeyOf<T>
) => {
  const plugin = new Plugin<AutomergePluginState>({
    key: automergePluginKey,
    state: {
      init(config, instance) {
        return { heads: [] }
      },
      apply(tr, value, oldState) {
        const meta = tr.getMeta(automergePluginKey)
        if (meta) {
          return { heads: meta.heads }
        }

        prosemirrorTransactionToAutomerge(
          tr.steps,
          handle.change.bind(handle),
          attribute,
          oldState
        )
        return { heads: Automerge.getBackend(handle.doc as Doc<T>).getHeads() }
      },

      toJSON(value) {
        return value
      },
      fromJSON(_config, value, _state) {
        return value
      },
    },
  })

  return plugin
}

export const createProsemirrorTransactionOnChange = <T>(
  state: EditorState,
  attribute: TextKeyOf<T>,
  doc: Doc<T>
) => {
  const pluginState = automergePluginKey.getState(state)
  const currentHeads = pluginState?.heads
  if (!currentHeads) {
    throw new Error("No heads found on plugin state")
  }

  const newHeads: string[] = Automerge.getBackend(doc as Doc<T>).getHeads()
  if (newHeads.every((val, i) => val === currentHeads[i])) {
    console.log("heads haven't changed.")
    return state.tr // noop transaction
    // TODO: we should just filter these events at the source when we get patches
  }

  const attribution = attributedTextChanges(doc, currentHeads, attribute)

  const transaction = convertAutomergeTransactionToProsemirrorTransaction(
    doc,
    attribute,
    state,
    attribution
  )

  transaction.setMeta(automergePluginKey, {
    heads: newHeads,
  })

  return transaction
}
