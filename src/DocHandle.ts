/* So this class is kind of terrible because we have to be careful to preserve a 1:1
 * relationship between handles and documentIds or else we have split-brain on listeners.
 * It would be easier just to have one repo object to pass around but that means giving
 * total repo access to everything which seems gratuitous to me.
 */
import EventEmitter, * as MoreEventEmitter from 'eventemitter3'
import * as Automerge from 'automerge-js'

interface DocHandleEventArg { 
  handle: DocHandle, 
  documentId: string, 
  doc: Automerge.Doc, 
  changes: Uint8Array[]
  attribution: unknown
}
export interface DocHandleEvents {
  'change': (event: DocHandleEventArg) => void
}

interface BlockData {
  start: number
  end: number,
  type: string,
  attributes?: unknown
}

export default class DocHandle extends MoreEventEmitter<DocHandleEvents> implements EventEmitter<DocHandleEvents> {
  doc?: Automerge.Doc

  documentId

  constructor(documentId: string) {
    super()
    if (!documentId) { throw new Error('Need a document ID for this RepoDoc.') }
    this.documentId = documentId
  }

  // should i move this?
  change(callback: (doc: Automerge.Doc) => void) {
    const doc = Automerge.change(this.doc, callback)
    this.replace(doc)
  }

  replace(doc: Automerge.Doc) {
    const oldDoc = this.doc
    this.doc = doc
    const { documentId } = this

    let attribution = null
    const textObj = Automerge.getBackend(doc).get('_root', 'message') // yikes
    if (textObj && textObj[0] === 'text' ) {
      const oldHeads = Automerge.getBackend(oldDoc).getHeads()
      const newHeads = Automerge.getBackend(doc).getHeads()
      attribution = Automerge.getBackend(doc).attribute(textObj[1], oldHeads, [newHeads])
    }

    this.emit('change', {
      handle: this,
      documentId,
      doc,
      changes: Automerge.getChanges(oldDoc || Automerge.init(), doc),
      attribution,
    })
  }


  /* hmmmmmmmmmmm */
  async value() {
    if (!this.doc) {
      /* this bit of jank blocks anyone else getting the value
         before the first time data gets set into here */
      await new Promise((resolve) => {
        this.once('change', resolve)
      })
    }
    return this.doc
  }

  /* these would ideally be exposed on the text/list proxy objs; doing them here
   * for experimental purposes only. */
  dangerousLowLevel() {
    return Automerge.getBackend(this.doc)
  }

  getObjId(objId: string, attr: string) {
    const data = this.dangerousLowLevel().getAll(objId, attr)
    if (data && data.length === 1) { return data[0][1] }
  }

  getMarks(objId: string) {
    return this.dangerousLowLevel().raw_spans(objId)
  }

  mark(objId: string, range: string, name: string, value: string) {
    this.dangerousLowLevel().mark(objId, range, name, value)
  }

  textInsertAt(objId: string, position: number, value: string) {
    const ins = this.dangerousLowLevel().splice(objId, position, 0, value)
    if (!this.doc) { throw new Error("can't insert without a doc")}
    this.replace(this.doc)
    return ins
  }

  textDeleteAt(objId: string, position: number, count = 1) {
    return this.dangerousLowLevel().splice(objId, position, count, '')
  }

  textInsertBlock(objId: string, position: number, type: string, attributes: { [key: string]: unknown } = {}) {
    const block: { [attr: string] : unknown } = { type }
    Object.keys(attributes).forEach((key) => {
      block[`attribute-${key}`] = attributes[key]
    })
    return this.dangerousLowLevel().insertObject(objId, position, block)
  }

  textGetBlock(objId: string, position: number) {
    return this.dangerousLowLevel().get(objId, position)
  }
  
  textGetBlocks(objId: string) {
    if (!this.doc) { throw new Error("Missing doc")}
    const text = this.doc[objId]
    const string = this.textToString(objId)
    const blocks: BlockData[] = []

    console.log(string.replace('\uFFFC', 'X'))

    const initial = string.indexOf('\uFFFC')

    // If there isn't a block at the start of the document, create a virtual one
    // because we need it for prosemirror
    if (initial !== 0) {
      console.log('adding initial virtual paragraph')
      const end = (initial === -1) ? string.length : initial

      blocks.push({
        start: 0,
        end,
        type: 'paragraph',
        attributes: { virtual: true }
      })
    }

    if (initial > -1) {
      console.log('trying to create a new paragraph')
      let i = initial
      while (i !== -1) {
        const next = string.indexOf('\uFFFC', i + 1)
        const end = (next === -1) ? string.length : next
        blocks.push({
          start: i,
          end,
          type: text[i]['type']
        })
        i = next
      }
    }

    return blocks
  }

  textToString(objId: string) {
    const string: string[] = []
    if (!this.doc) { throw new Error("Missing doc")}
    const text = this.doc[objId]
    console.log(objId, text)
    for (let i = 0; i < text.length; i++) {
      console.log(typeof text[i])
      if (typeof text[i] === 'string') {
        string.push(text[i])
      } else {
        string.push('\uFFFC')
      }
    }
    return string.join('')
  }
}
