import * as Automerge from "automerge"
import { AutomergeTransaction } from "./automerge/AutomergeTypes"

export interface BlockData {
  start: number
  end: number
  type: string
  attributes?: unknown
}

export function attributedTextChanges(
  doc: Automerge.Doc<unknown>,
  prevHeads: Automerge.Doc<unknown>,
  objId: string
): AutomergeTransaction {
  const newHeads = (Automerge as any).getBackend(doc).getHeads()
  const textObj = (Automerge as any).getBackend(doc).get("_root", objId)

  if (!textObj) {
    console.warn(`attributedChanges: ${objId} was not found in the document`)
    return [] as AutomergeTransaction
  }

  return (Automerge as any)
    .getBackend(doc)
    .attribute(textObj, prevHeads, [newHeads])
}

export function getObjId(
  doc: Automerge.Doc<unknown>,
  objId: string,
  attr: string
) {
  const data = (Automerge as any).getBackend(doc).getAll(objId, attr)
  if (data && data.length === 1) {
    return data[0][1]
  }
}

export function textGetMarks(doc: Automerge.Doc<unknown>, objId: string) {
  return (Automerge as any).getBackend(doc).raw_spans(objId)
}

export function textMark(
  doc: Automerge.Doc<unknown>,
  objId: string,
  range: string,
  name: string,
  value: string
) {
  ;(Automerge as any).getBackend(doc).mark(objId, range, name, value)
}

export function textInsertAt(
  doc: Automerge.Doc<unknown>,
  objId: string,
  position: number,
  value: string
) {
  const ins = (Automerge as any)
    .getBackend(doc)
    .splice(objId, position, 0, value)
  return ins
}

export function textDeleteAt(
  doc: Automerge.Doc<unknown>,
  objId: string,
  position: number,
  count = 1
) {
  return (Automerge as any).getBackend(doc).splice(objId, position, count, "")
}

export function textInsertBlock(
  doc: Automerge.Doc<unknown>,
  objId: string,
  position: number,
  type: string,
  attributes: { [key: string]: unknown } = {}
) {
  const block: { [attr: string]: unknown } = { type }
  Object.keys(attributes).forEach((key) => {
    block[`attribute-${key}`] = attributes[key]
  })
  return (Automerge as any).getBackend(doc).insertObject(objId, position, block)
}

export function textGetBlock(
  doc: Automerge.Doc<unknown>,
  objId: string,
  position: number
) {
  return (Automerge as any).getBackend(doc).get(objId, position)
}

export function textGetBlocks(doc: Automerge.Doc<unknown>, objId: string) {
  if (!doc) {
    throw new Error("Missing doc")
  }
  const text = (doc as any)[objId]
  const string = textToString(doc, objId)
  const blocks: BlockData[] = []

  const initial = string.indexOf("\uFFFC")

  // If there isn't a block at the start of the document, create a virtual one
  // because we need it for prosemirror
  if (initial !== 0) {
    const end = initial === -1 ? string.length : initial

    blocks.push({
      start: 0,
      end,
      type: "paragraph",
      attributes: { virtual: true },
    })
  }

  if (initial > -1) {
    let i = initial
    while (i !== -1) {
      const next = string.indexOf("\uFFFC", i + 1)
      const end = next === -1 ? string.length : next
      blocks.push({
        start: i,
        end,
        type: text[i]["type"],
      })
      i = next
    }
  }

  return blocks
}

export function textToString(doc: Automerge.Doc<unknown>, objId: string) {
  const string: string[] = []
  if (!doc) {
    throw new Error("Missing doc")
  }
  const text = (doc as any)[objId]
  if (!text) {
    return ""
  }
  for (let i = 0; i < text.length; i++) {
    if (typeof text[i] === "string") {
      string.push(text[i])
    } else {
      string.push("\uFFFC")
    }
  }
  return string.join("")
}
