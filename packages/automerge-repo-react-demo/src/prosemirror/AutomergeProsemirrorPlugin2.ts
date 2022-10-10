import * as Automerge from "@automerge/automerge"
import { Doc } from "@automerge/automerge"
import { DocHandle } from "automerge-repo"
import { PluginKey, Plugin, EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { convertAutomergeTransactionToProsemirrorTransaction } from "./automerge/AutomergeToProsemirrorTransaction"
import { TextKeyOf } from "./automerge/AutomergeTypes"
import { prosemirrorTransactionToAutomerge } from "./automerge/ProsemirrorTransactionToAutomerge"

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

  let onPatchHandler = (args: DocHandlePatchEventArg<T>) => { }

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

        /*
        prosemirrorTransactionToAutomerge(
          tr.steps,
          handle.change.bind(handle),
          attribute,
          oldState
        )
        */

        //return { heads: Automerge.getBackend(handle.doc as Doc<T>).getHeads() }
      },

      toJSON(value) {
        return value
      },
      fromJSON(_config, value, _state) {
        return value
      },
    },
    view: () => {
      // We only implement the view so that we detach from Automerge events
      // after the editor has been destroyed.
      return {
        destroy: () => {
          handle.off('patch', onPatchHandler)
        }
      }
    }
  })

  const listen = (editorState: EditorState, editorView: EditorView) => {
    onPatchHandler = (args: DocHandlePatchEventArg<T>) => {
      const pluginState = automergePluginKey.getState(editorState)
      const currentHeads = pluginState?.heads
      if (!currentHeads) {
        throw new Error("No heads found on plugin state")
      }

      console.log(args)
      debugger
      //const newHeads: string[] = Automerge.getBackend(handle.doc as Doc<T>).getHeads()
      /*
      if (newHeads.every((val, i) => val === currentHeads[i])) {
        console.log("heads haven't changed.")
        return // noop transaction
        // TODO: we should just filter these events at the source when we get patches
      }
      */

      let tr = editorState.tr
      if (args.patch.path[0] !== attribute) return
      console.group('IN PATCH', editorState)
      switch (args.patch.action) {
        case "splice":
          console.log('SPLICE', args.patch)
          console.log('plugin state', plugin)
          const insertion = args.patch.values.join('')
          const from = args.patch.path[1]
          tr = tr.insertText(insertion, from + 1, from + 1)
          console.log(tr.steps)
          break
        default:
          console.log('something else', args.patch)
      }
      let newState = editorView.state.apply(tr)
      editorView.updateState(newState)
      console.log(tr, newState)
      console.groupEnd()
    }

    console.log('listening')
    handle.on('patch', onPatchHandler)
  }

  return { plugin, listen }
}

/*
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

  const attribution = getTextChanges(doc, currentHeads, attribute)
  //const attribution = attributedTextChanges(doc, currentHeads, attribute)

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

*/