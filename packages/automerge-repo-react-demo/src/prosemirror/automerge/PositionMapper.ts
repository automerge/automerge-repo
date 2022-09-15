// we could use automerge.text.toSpans() instead of this, but I'm leaving this
// here for now since I think the current automerge-js api is a bit of a

import { EditorState } from "prosemirror-state"

// foot-gun and could do with some tweaking.
export const BLOCK_MARKER = "\uFFFC"

export const automergeToProsemirror = (
  step: { start: number; end: number },
  text: string
) => {
  return {
    from: automergeToProsemirrorNumber(step.start, text),
    to: automergeToProsemirrorNumber(step.end, text),
  }
}

export const automergeToProsemirrorNumber = (
  position: number,
  text: string
) => {
  // first, count how many paragraphs we have. n.b. that this won't work once/if
  // we have nested blocks.
  //
  let idx = text.indexOf(BLOCK_MARKER)

  let automergeBlockPositions = 0
  let prosemirrorBlockPositions = 1
  while (idx < position && idx !== -1) {
    idx = text.indexOf(BLOCK_MARKER, idx + 1)
    automergeBlockPositions++
    prosemirrorBlockPositions += 2
  }

  // this is how many blocks precede the current one.
  // BtextBmore textBmo^re text after pos
  // <p>text</p><p>more text</p><p>mo^re text after pos</p>

  // this is probably wrong, but right now blocks aren't working, so it's hard
  // to establish what the correct behaviour will be.
  return position - prosemirrorBlockPositions + automergeBlockPositions + 2
}

export const prosemirrorToAutomergeNumber = (
  position: number,
  text: string,
  state: EditorState
) => {
  let idx = 0
  let blocks = 0
  let offset = 0
  let nudge = 0
  while (idx < state.doc.content.childCount) {
    let contentNode = state.doc.content.maybeChild(idx)
    if (!contentNode) continue
    let nodeSize = contentNode.nodeSize
    offset += nodeSize

    if (offset > position) {
      if (nodeSize === 2 && offset === position) nudge = -1
      break
    }
    idx++
    blocks++
  }

  const noBlockNudge = text.indexOf(BLOCK_MARKER, 0) === 0 ? 0 : 1

  let amPosition = position - blocks + nudge - noBlockNudge

  /*-- IN CASE OF POSITION MAPPING ISSUES
   *
   * reverseMap should equal proseMirrorPosition
   *
   * n.b. the last position of the document does not necessarily match, but
   * that's okay because prosemirror likes to put the cursor _after_ the last
   * closing tag, but insertions happen _inside_ that tag (or tags), but we
   * don't have a way to reverse-map that and the behaviour is equivalent.
   * I *think* the warnings that this code produces in that specific scenario
   * are ignorable.
   *
   * UNBREAK COMMENT HERE
   

  let am2pm = automergeToProsemirrorNumber(amPosition, text)

  console.log({
    proseMirrorPosition: position,
    automergeEquivalent: amPosition,
    reverseMap: am2pm,
    correct: am2pm === position,
  })

  if (am2pm !== position) {
    console.log('Error: PM<->AM position mapping inconsistentcy detected.')
    console.log({
      prosemirrorState: state,
      prosemirrorDoc: state.doc,
      //automergeDraft: doc,
      //automergeDraftText: `-->${doc.text}<--`,
      math: {
        idx,
        blocks,
        offset,
        nudge,
      },
    })
  }
  /**/

  return amPosition
}

export const prosemirrorToAutomerge = (
  position: { from: number; to: number },
  text: string /* for debugging purposes only */,
  state: EditorState
) => {
  //: { start: number; end: number } => {
  return {
    start: prosemirrorToAutomergeNumber(position.from, text, state),
    end: prosemirrorToAutomergeNumber(position.to, text, state),
  }
}
