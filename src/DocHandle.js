/* So this class is kind of terrible because we have to be careful to preserve a 1:1
 * relationship between handles and documentIds or else we have split-brain on listeners.
 * It would be easier just to have one repo object to pass around but that means giving
 * total repo access to everything which seems gratuitous to me.
 */
import EventEmitter from 'eventemitter3'
import * as Automerge from 'automerge-js'

export default class DocHandle extends EventEmitter {
  #doc

  documentId

  constructor(documentId) {
    super()
    if (!documentId) { throw new Error('Need a document ID for this RepoDoc.') }
    this.documentId = documentId
  }

  // should i move this?
  change(callback) {
    const doc = Automerge.change(this.#doc, callback)
    this.replace(doc)
  }

  replace(doc) {
    const oldDoc = this.#doc
    this.#doc = doc
    const { documentId } = this
    this.emit('change', {
      handle: this,
      documentId,
      doc,
      changes: Automerge.getChanges(oldDoc || Automerge.init(), doc),
    })
  }

  /* hmmmmmmmmmmm */
  async value() {
    if (!this.#doc) {
      /* this bit of jank blocks anyone else getting the value
         before the first time data gets set into here */
      await new Promise((resolve) => {
        this.once('change', resolve)
      })
    }
    return this.#doc
  }

  /* these would ideally be exposed on the text/list proxy objs; doing them here
   * for experimental purposes only. */
  dangerousLowLevel() {
    return Automerge.getBackend(this.#doc)
  }

  getObjId(objId, attr) {
    let data = this.dangerousLowLevel().getAll(objId, attr)
    if (data && data.length === 1) { return data[0][1] }
  }

  getMarks(objId) {
    return this.dangerousLowLevel().raw_spans(objId)
  }

  mark(objId, range, name, value) {
    this.dangerousLowLevel().mark(objId, range, name, value)
  }

  textInsertAt(objId, position, value) {
    let ins = this.dangerousLowLevel().splice(objId, position, 0, value)
    this.replace(this.#doc)
    return ins
  }

  textDeleteAt(objId, position, count = 1) {
    return this.dangerousLowLevel().splice(objId, position, count, '')
  }

  textInsertBlock(objId, position, type, attributes = {}) {
    let block = { type }
    Object.keys(attributes).forEach((key) => {
      block[`attribute-${key}`] = attributes[key]
    })
    return this.dangerousLowLevel().insertObject(objId, position, block)
  }

  textGetBlock(objId, position) {
    return this.dangerousLowLevel().get(objId, position)
  }
  
  textGetBlocks(objId) {
    let text = this.#doc[objId]
    let string = this.textToString(objId)
    let blocks = []

    console.log(string.replace('\uFFFC', 'X'))

    let initial = string.indexOf('\uFFFC');

    // If there isn't a block at the start of the document, create a virtual one
    // because we need it for prosemirror
    if (initial !== 0) {
      console.log('adding initial virtual paragraph')
      let end = (initial === -1) ? string.length : initial

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
        let next = string.indexOf('\uFFFC', i + 1)
        let end = (next === -1) ? string.length : next
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

  textToString(objId) {
    let string = []
    let text = this.#doc[objId]
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
