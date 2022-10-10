import React, { useEffect, useRef } from "react"

import { Command, EditorState, Transaction } from "prosemirror-state"
import { keymap } from "prosemirror-keymap"
import { baseKeymap, toggleMark } from "prosemirror-commands"
import { history, redo, undo } from "prosemirror-history"
import { schema } from "prosemirror-schema-basic"
import { MarkType } from "prosemirror-model"

import { DocHandle, DocHandleChangeEventArg, DocHandlePatchEventArg } from "automerge-repo"
import { TextKeyOf } from "./automerge/AutomergeTypes"

import { EditorView } from "prosemirror-view"
import { automergePlugin } from "./AutomergeProsemirrorPlugin2"

export type EditorProps<T> = {
  handle: DocHandle<T>
  attribute: TextKeyOf<T>
}

const toggleBold = toggleMarkCommand(schema.marks.strong)
const toggleItalic = toggleMarkCommand(schema.marks.em)

function toggleMarkCommand(mark: MarkType): Command {
  return (
    state: EditorState,
    dispatch: ((tr: Transaction) => void) | undefined
  ) => {
    return toggleMark(mark)(state, dispatch)
  }
}

export function Editor<T>({ handle, attribute }: EditorProps<T>) {
  const editorRoot = useRef<HTMLDivElement>(null!)

  const amPlugin = automergePlugin(handle, attribute)

  useEffect(() => {
    let editorConfig = {
      schema,
      history,
      plugins: [
        amPlugin.plugin,
        keymap({
          ...baseKeymap,
          "Mod-b": toggleBold,
          "Mod-i": toggleItalic,
          "Mod-z": undo,
          "Mod-y": redo,
          "Mod-Shift-z": redo,
        }),
      ],
    }

    let state = EditorState.create(editorConfig)
    const view = new EditorView(editorRoot.current, { state })

    amPlugin.listen(state, view)

    //handle.value().then((doc) => {
    //  if (view.isDestroyed) { return /* too late */ }
      
      /*
      const transaction = createProsemirrorTransactionOnChange(
        view.state,
        attribute,
        doc
      )
      view.updateState(view.state.apply(transaction))
      */
    //})
    /*
    const onChange = (args: DocHandleEventArg<T>) => {
      const transaction = createProsemirrorTransactionOnChange(
        view.state,
        attribute,
        args.doc
      )
      view.updateState(view.state.apply(transaction))
    }
    handle.on("change", onChange)
    */

    /*
    const onPatch = (args: DocHandlePatchEventArg<T>) => {
      console.log('patch', args.patch)
    }
    handle.on('patch', onPatch)
    */

    /* move this out, we're in a then */
    return () => {
      // console.log("cleaning up")
      //handle.off("change", onChange)
      //handle.off("patch", onPatch)
      view.destroy()
    }
  }, [handle, attribute])

  return <div ref={editorRoot}></div>
}
